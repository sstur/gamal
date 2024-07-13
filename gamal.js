#!/usr/bin/env node

const fs = require('fs');
const http = require('http');
const readline = require('readline');

const GAMAL_HTTP_PORT = process.env.GAMAL_HTTP_PORT;
const GAMAL_TELEGRAM_TOKEN = process.env.GAMAL_TELEGRAM_TOKEN;

const LLM_API_KEY = process.env.LLM_API_KEY;
const LLM_API_BASE_URL = process.env.LLM_API_BASE_URL || 'https://openrouter.ai/api/v1';
const LLM_CHAT_MODEL = process.env.LLM_CHAT_MODEL || 'meta-llama/llama-3-8b-instruct';
const LLM_STREAMING = process.env.LLM_STREAMING !== 'no';

const YOU_API_KEY = process.env.YOU_API_KEY;
const TOP_K = 3;

const LLM_DEBUG_CHAT = process.env.LLM_DEBUG_CHAT;
const LLM_DEBUG_PIPELINE = process.env.LLM_DEBUG_PIPELINE;
const LLM_DEBUG_SEARCH = process.env.LLM_DEBUG_SEARCH;
const LLM_DEBUG_FAIL_EXIT = process.env.LLM_DEBUG_FAIL_EXIT;

const NORMAL = '\x1b[0m';
const BOLD = '\x1b[1m';
const YELLOW = '\x1b[93m';
const MAGENTA = '\x1b[35m';
const RED = '\x1b[91m';
const GREEN = '\x1b[92m';
const CYAN = '\x1b[36m';
const GRAY = '\x1b[90m';
const ARROW = '⇢';
const CHECK = '✓';
const CROSS = '✘';

/**
 * Creates a new function by chaining multiple async functions from left to right.
 *
 * @param  {...any} fns - Functions to chain
 * @returns {function}
 */
const pipe = (...fns) => arg => fns.reduce((d, fn) => d.then(fn), Promise.resolve(arg));


/**
 * Represents a chat message.
 *
 * @typedef {Object} Message
 * @property {'system'|'user'|'assistant'} role
 * @property {string} content
 */

/**
 * A callback function to stream then completion.
 *
 * @callback CompletionHandler
 * @param {string} text
 * @returns {void}
 */

/**
 * Generates a chat completion using a RESTful LLM API service.
 *
 * @param {Array<Message>} messages - List of chat messages.
 * @param {CompletionHandler=} handler - An optional callback to stream the completion.
 * @returns {Promise<string>} The completion generated by the LLM.
 */

const chat = async (messages, handler) => {
    const url = `${LLM_API_BASE_URL}/chat/completions`;
    const auth = LLM_API_KEY ? { 'Authorization': `Bearer ${LLM_API_KEY}` } : {};
    const model = LLM_CHAT_MODEL || 'gpt-3.5-turbo';
    const stop = ['<|im_end|>', '<|end|>', '<|eot_id|>', '<|end_of_turn|>', 'INQUIRY: '];;
    const max_tokens = 400;
    const temperature = 0;
    const stream = LLM_STREAMING && typeof handler === 'function';
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth },
        body: JSON.stringify({ messages, model, stop, max_tokens, temperature, stream })
    });
    if (!response.ok) {
        throw new Error(`HTTP error with the status: ${response.status} ${response.statusText}`);
    }

    LLM_DEBUG_CHAT && messages.forEach(({ role, content }) => {
        console.log(`${MAGENTA}${role}:${NORMAL} ${content}`);
    });

    if (!stream) {
        const data = await response.json();
        const { choices } = data;
        const first = choices[0];
        const { message } = first;
        const { content } = message;
        const answer = content.trim();
        handler && handler(answer);
        LLM_DEBUG_CHAT && console.log(`${YELLOW}${answer}${NORMAL}`);
        return answer;
    }

    const parse = (line) => {
        let partial = null;
        const prefix = line.substring(0, 6);
        if (prefix === 'data: ') {
            const payload = line.substring(6);
            try {
                const { choices } = JSON.parse(payload);
                const [choice] = choices;
                const { delta } = choice;
                partial = delta?.content;
            } catch (e) {
                // ignore
            } finally {
                return partial;
            }
        }
        return partial;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    let answer = '';
    let buffer = '';
    while (true) {
        const { value, done } = await reader.read();
        if (done) {
            break;
        }
        const lines = decoder.decode(value).split('\n');
        for (let i = 0; i < lines.length; ++i) {
            const line = buffer + lines[i];
            if (line[0] === ':') {
                buffer = '';
                continue;
            }
            if (line === 'data: [DONE]') {
                break;
            }
            if (line.length > 0) {
                const partial = parse(line);
                if (partial === null) {
                    buffer = line;
                } else if (partial && partial.length > 0) {
                    buffer = '';
                    if (answer.length < 1) {
                        const leading = partial.trim();
                        answer = leading;
                        handler && (leading.length > 0) && handler(leading);
                    } else {
                        answer += partial;
                        handler && handler(partial);
                    }
                }
            }
        }
    }
    return answer;
}

const PREDEFINED_KEYS = ['INQUIRY', 'TOOL', 'LANGUAGE', 'THOUGHT', 'KEYPHRASES', 'OBSERVATION', 'TOPIC'];

/**
 * Break downs a multi-line text based on a number of predefined keys.
 *
 * @param {string} text
 * @returns {Array<string>}
 */

const deconstruct = (text, markers = PREDEFINED_KEYS) => {
    const parts = {};
    const keys = [...markers].reverse();
    const anchor = markers.slice().pop();
    const start = text.lastIndexOf(anchor + ':');
    if (start >= 0) {
        parts[anchor.toLowerCase()] = text.substring(start).replace(anchor + ':', '').trim();
        let str = text.substring(0, start);
        for (let i = 0; i < keys.length; ++i) {
            const marker = keys[i];
            const pos = str.lastIndexOf(marker + ':');
            if (pos >= 0) {
                const substr = str.substr(pos + marker.length + 1).trim();
                const value = substr.split('\n').shift();
                str = str.slice(0, pos);
                const key = marker.toLowerCase();
                parts[key] = value;
            }
        }
    }
    return parts;
}

/**
 * Constructs a multi-line text based on a number of key-value pairs.
 *
 * @param {Object} key-value pairs
 * @return {text}
 */
const construct = (kv) => {
    return PREDEFINED_KEYS.filter(key => kv[key.toLowerCase()]).map(key => {
        const value = kv[key.toLowerCase()];
        if (value && value.length > 0) {
            return `${key.toUpperCase()}: ${value}`;
        }
        return null;
    }).join('\n');
}

/**
 * Represents the record of an atomic processing.
 *
 * @typedef {Object} Stage
 * @property {string} name
 * @property {number} timestamp (Unix epoch)
 * @property {number} duration (in ms)
 */

/**
 * Represents the contextual information for each pipeline stage.
 *
 * @typedef {Object} Context
 * @property {Array<object>} history
 * @property {string} inquiry
 * @property {string} thought
 * @property {string} keyphrases
 * @property {string} observation
 * @property {string} answer
 * @property {Object.<string, function>} delegates - Impure functions to access the outside world.
 */

/**
 * Performs a basic step-by-step reasoning, in the style of Chain of Thought.
 * The updated context will contains new information such as `keyphrases` and `observation`.
 *
 * @param {Context} context - Current pipeline context.
 * @returns {Context} Updated pipeline context.
 */

const REASON_PROMPT = `You are Gamal, a world-class answering assistant.
You are interacting with a human who gives you an inquiry.
Your task is as follows.
Use Google to search for the answer. Think step by step. Fix any misspelings.
If necessary, refer to the relevant part of the previous conversation history.
Use the same language as the inquiry.

Always output your thought in the following format:

TOOL: the search engine to use (must be Google).
LANGUAGE: the language of the inquiry.
THOUGHT: describe your thoughts about the inquiry.
KEYPHRASES: the important query to give to Google.
OBSERVATION: the concise result of the search tool.
TOPIC: the specific topic covering the inquiry.`;

const REASON_EXAMPLE = `

# Example

Given an inquiry "Pour quoi le lac de Pitch à Trinidad est-il célèbre?", you will output:

TOOL: Google.
LANGUAGE: French.
THOUGHT: Cela concerne la géographie, je vais utiliser la recherche Google.
KEYPHRASES: Pitch Lake in Trinidad famerenommée du lac de Pitch à Trinidad.
OBSERVATION: Le lac de Pitch à Trinidad est le plus grand dépôt naturel d'asphalte.
TOPIC: géographie.`;

const breakdown = (hint, completion) => {
    const text = hint + completion;
    let result = deconstruct(text);
    const { topic } = result;
    if (!topic || topic.length === 0) {
        result = deconstruct(text + '\n' + 'TOPIC: general knowledge.');
    }
    return result;
}

const reason = async (context) => {
    const { history, delegates } = context;
    const { enter, leave } = delegates;
    enter && enter('Reason');

    const relevant = history.slice(-3);
    let prompt = REASON_PROMPT;
    if (relevant.length === 0) {
        prompt += REASON_EXAMPLE;
    }

    const messages = [];
    messages.push({ role: 'system', content: prompt });
    relevant.forEach(msg => {
        const { inquiry, topic, thought, keyphrases, answer } = msg;
        const observation = answer;
        messages.push({ role: 'user', content: inquiry });
        const assistant = construct({ tool: 'Google.', thought, keyphrases, observation, topic });
        messages.push({ role: 'assistant', content: assistant });
    });

    const { inquiry } = context;
    messages.push({ role: 'user', content: inquiry });
    const hint = ['TOOL: Google.', 'LANGUAGE: '].join('\n');
    messages.push({ role: 'assistant', content: hint });
    const completion = await chat(messages);
    let result = breakdown(hint, completion);
    if (!result.keyphrases || result.keyphrases.length === 0) {
        LLM_DEBUG_CHAT && console.log(`-->${RED}Invalid keyphrases. Trying again...`);
        const hint = ['TOOL: Google.', 'THOUGHT: ' + result.thought, 'KEYPHRASES: '].join('\n');
        messages.pop();
        messages.push({ role: 'assistant', content: hint });
        const completion = await chat(messages);
        result = breakdown(hint, completion);
    }
    const { language, topic, thought, keyphrases, observation } = result;
    leave && leave('Reason', { language, topic, thought, keyphrases, observation });
    return { language, topic, thought, keyphrases, observation, ...context };
}

/**
 * Uses the online search engine to collect relevant information based on the keyphrases.
 * The TOP_K most relevant results will be stored in `references`.
 *
 * @param {Context} context - Current pipeline context.
 * @returns {Context} Updated pipeline context.
 */
const search = async (context, attempt = 3) => {
    const { delegates, keyphrases, observation } = context;
    const { enter, leave } = delegates;
    enter && enter('Search');

    const query = keyphrases.replace(/\.$/, "").replace(/^"|"$/g, "");

    let url = new URL('https://api.ydc-index.io/search');
    url.searchParams.append('query', query);
    url.searchParams.append('num_web_results', TOP_K);

    const response = await fetch(url, {
        method: 'GET',
        headers: {
            'Content-Type': 'application/json',
            'X-API-Key': YOU_API_KEY
        }
    });
    const data = await response.json();
    if (!response.ok) {
        if (attempt > 1) {
            LLM_DEBUG_SEARCH && console.log('You.com failed. Retrying...');
            return await search(context, attempt - 1);
        } else {
            throw new Error(`You.com call failed with status: ${response.status}`);
        }
    }
    const { hits = [] } = data;
    LLM_DEBUG_SEARCH && console.log('Search result: ', { query, data, hits });
    let references = [];
    if (Array.isArray(hits) && hits.length > 0) {
        const MAX_CHARS = 1000;
        references = hits.slice(0, TOP_K).map((hit, i) => {
            const { title, url, description = '', snippets = [] } = hit;
            const snippet = description + snippets.join('\n').substring(0, MAX_CHARS);
            return { position: i + 1, title, url, snippet };
        });
    } else {
        if (attempt > 1) {
            LLM_DEBUG_SEARCH && console.log('Something is wrong, search gives no result. Retrying...');
            return await search(context, attempt - 1);
        }
    }

    leave && leave('Search', { references });
    return { ...context, references };
}

/**
 * Responds to the user's recent message using an LLM.
 * The response from the LLM is available as `answer` in the updated context.
 *
 * @param {Context} context - Current pipeline context.
 * @returns {Context} Updated pipeline context.
 */

const RESPOND_PROMPT = `You are a world-renowned research assistant.
You are given a user question, and please write clean, concise and accurate answer to the question.
You will be given a set of related references to the question, each starting with a reference number like [citation:x], where x is a number.
Please use only 3 most relevant references, not all of them.
Cite each reference at the end of each sentence.

You are expected to provide an answer that is accurate, correct, and reflect expert knowledge.
Your answer must maintain an unbiased and professional tone.
Your answer should not exceed 3 sentences in length, unless the instruction is to do so.

Do not give any information that is not related to the question, and do not repeat.
No need to mention "according to the references..." and other internal references.

After every sentence, always cite the reference with the citation numbers, in the format [citation:x].
If a sentence comes from multiple references, please list all applicable citations, like [citation:3][citation:5].

Here are the set of references:

{REFERENCES}

Remember, don't blindly repeat the references verbatim.
Only supply the answer and do not add any additional commentaries, notes, remarks, list of citations, literature references, extra translations, postanalysis.

Your answer must be in the same language as the inquiry, i.e. {LANGUAGE}.

And here is the user question:`;

const respond = async (context) => {
    const { delegates } = context;
    const { enter, leave, stream } = delegates;
    enter && enter('Respond');

    const { inquiry, language, references } = context;

    const messages = [];
    if (references && Array.isArray(references) && references.length > 0) {
        const refs = references.map(ref => {
            const { position, title, snippet } = ref;
            return `[citation:${position}] ${title} - ${snippet}`;
        });

        const prompt = RESPOND_PROMPT.replace('{LANGUAGE}', language).
            replace('{REFERENCES}', refs.join('\n'));
        messages.push({ role: 'system', content: prompt });
        messages.push({ role: 'user', content: inquiry });
    } else {
        console.error('No references to cite');
    }
    const answer = await chat(messages, stream);
    leave && leave('Respond', { inquiry });
    return { answer, ...context };
}

/**
 * Prints the pipeline stages, mostly for troubleshooting.
 *
 * @param {Array<Stage>} stages
 */
const review = (stages) => {
    let buffer = 'Pipeline review:\n';
    console.log();
    console.log(`${MAGENTA}Pipeline review ${NORMAL}`);
    console.log('---------------');
    stages.map((stage, index) => {
        const { name, duration, timestamp, ...fields } = stage;
        console.log(`${GREEN}${ARROW} Stage #${index + 1} ${YELLOW}${name} ${GRAY}[${duration} ms]${NORMAL}`);
        buffer += `\nStage #${index + 1} ${name} [${duration} ms]\n`;
        Object.keys(fields).map(key => {
            const value = fields[key];
            const str = Array.isArray(value) ? JSON.stringify(value, null, 2) : value.toString();
            console.log(`${GRAY}${key}: ${NORMAL}${str}`);
            buffer += `${key}: ${str}\n`;
        });
    });
    console.log();
    return buffer;
}

/**
 * Collapses every pair of stages (enter and leave) into one stage,
 * and compute its duration instead of invididual timestamps.
 *
 * @param {Array<object} stage
 * @returns {Array<object>}
 */
const simplify = (stages) => {
    const isOdd = (x) => { return (x % 2) !== 0 };
    return stages.map((stage, index) => {
        if (isOdd(index)) {
            const before = stages[index - 1];
            const duration = stage.timestamp - before.timestamp;
            return { ...stage, duration };
        }
        return stage;
    }).filter((_, index) => isOdd(index));
}

/**
 * Converts an expected answer into a suitable regular expression array.
 *
 * @param {string} match
 * @returns {Array<RegExp>}
 */
const regexify = (match) => {
    const filler = (text, index) => {
        let i = index;
        while (i < text.length) {
            if (text[i] === '/') {
                break;
            }
            ++i;
        }
        return i;
    };

    const pattern = (text, index) => {
        let i = index;
        if (text[i] === '/') {
            ++i;
            while (i < text.length) {
                if (text[i] === '/' && text[i - 1] !== '\\') {
                    break;
                }
                ++i;
            }
        }
        return i;
    };

    const regexes = [];
    let pos = 0;
    while (pos < match.length) {
        pos = filler(match, pos);
        const next = pattern(match, pos);
        if (next > pos && next < match.length) {
            const sub = match.substring(pos + 1, next);
            const regex = RegExp(sub, 'gi');
            regexes.push(regex);
            pos = next + 1;
        } else {
            break;
        }
    }

    if (regexes.length === 0) {
        regexes.push(RegExp(match, 'gi'));
    }

    return regexes;
}

/**
 * Returns all possible matches given a list of regular expressions.
 *
 * @param {string} text
 * @param {Array<RegExp>} regexes
 * @returns {Array<Span>}
 */
const match = (text, regexes) => {
    return regexes.map(regex => {
        const match = regex.exec(text);
        if (!match) {
            return null;
        }
        const [first] = match;
        const { index } = match;
        const { length } = first;
        return { index, length };
    }).filter(span => span !== null);
}

/**
 * Formats the input (using ANSI colors) to highlight the spans.
 *
 * @param {string} text
 * @param {Array<Span>} spans
 * @param {string} color
 * @returns {string}
 */

const highlight = (text, spans, color = BOLD + GREEN) => {
    let result = text;
    spans.sort((p, q) => q.index - p.index).forEach((span) => {
        const { index, length } = span;
        const prefix = result.substring(0, index);
        const content = result.substring(index, index + length);
        const suffix = result.substring(index + length);
        result = `${prefix}${color}${content}${NORMAL}${suffix}`;
    });
    return result;
}

/**
 * Evaluates a test file and executes the test cases.
 *
 * @param {string} filename - The path to the test file.
 */
const evaluate = async (filename) => {
    try {
        let history = [];
        let total = 0;
        let failures = 0;

        const handle = async (line) => {
            const parts = (line && line.length > 0) ? line.split(':') : [];
            if (parts.length >= 2) {
                const role = parts[0];
                const content = line.slice(role.length + 1).trim();
                if (role === 'Story') {
                    console.log();
                    console.log('-----------------------------------');
                    console.log(`Story: ${MAGENTA}${BOLD}${content}${NORMAL}`);
                    console.log('-----------------------------------');
                    history = [];
                } else if (role === 'User') {
                    const inquiry = content;
                    const stages = [];
                    const enter = (name) => { stages.push({ name, timestamp: Date.now() }) };
                    const leave = (name, fields) => { stages.push({ name, timestamp: Date.now(), ...fields }) };
                    const delegates = { enter, leave };
                    const context = { inquiry, history, delegates };
                    console.log();
                    process.stdout.write(`  ${inquiry}\r`);
                    const start = Date.now();
                    const pipeline = pipe(reason, search, respond);
                    const result = await pipeline(context);
                    const duration = Date.now() - start;
                    const { topic, thought, keyphrases, references, answer } = result;
                    history.push({ inquiry, thought, keyphrases, topic, references, answer, duration, stages });
                    ++total;
                } else if (role === 'Assistant') {
                    const expected = content;
                    const last = history.slice(-1).pop();
                    if (!last) {
                        console.error('There is no answer yet!');
                        process.exit(-1);
                    } else {
                        const { inquiry, answer, duration, references, stages } = last;
                        const target = answer;
                        const regexes = regexify(expected);
                        const matches = match(target, regexes);
                        if (matches.length === regexes.length) {
                            console.log(`${GREEN}${CHECK} ${CYAN}${inquiry} ${GRAY}[${duration} ms]${NORMAL}`);
                            console.log(' ', highlight(target, matches));
                            if (references && Array.isArray(references) && references.length > 0) {
                                references.forEach((reference) => {
                                    const { position, url } = reference;
                                    console.log(`  ${GRAY}[${position}] ${url}${NORMAL}`);
                                })
                            }
                            LLM_DEBUG_PIPELINE && review(simplify(stages));
                        } else {
                            ++failures;
                            console.error(`${RED}${CROSS} ${YELLOW}${inquiry} ${GRAY}[${duration} ms]${NORMAL}`);
                            console.error(`Expected ${role} to contain: ${CYAN}${regexes.join(',')}${NORMAL}`);
                            console.error(`Actual ${role}: ${MAGENTA}${target}${NORMAL}`);
                            review(simplify(stages));
                            LLM_DEBUG_FAIL_EXIT && process.exit(-1);
                        }
                    }
                } else if (role === 'Pipeline.Reason.Keyphrases' || role === 'Pipeline.Reason.Topic') {
                    const expected = content;
                    const last = history.slice(-1).pop();
                    if (!last) {
                        console.error('There is no answer yet!');
                        process.exit(-1);
                    } else {
                        const { keyphrases, topic, stages } = last;
                        const target = (role === 'Pipeline.Reason.Keyphrases') ? keyphrases : topic;
                        const regexes = regexify(expected);
                        const matches = match(target, regexes);
                        if (matches.length === regexes.length) {
                            console.log(`    ${ARROW} ${GRAY}${role}:`, highlight(target, matches, GREEN));
                        } else {
                            ++failures;
                            console.error(`${RED}Expected ${role} to contain: ${CYAN}${regexes.join(',')}${NORMAL}`);
                            console.error(`${RED}Actual ${role}: ${MAGENTA}${target}${NORMAL}`);
                            review(simplify(stages));
                            LLM_DEBUG_FAIL_EXIT && process.exit(-1);
                        }
                    }
                } else {
                    console.error(`Unknown role: ${role}!`);
                    handle.exit(-1);
                }
            }
        };

        const trim = (input) => {
            const text = input.trim();
            const marker = text.indexOf('#');
            if (marker >= 0) {
                return text.substr(0, marker).trim();
            }
            return text;
        }

        const lines = fs.readFileSync(filename, 'utf-8').split('\n').map(trim);
        for (const i in lines) {
            await handle(lines[i]);
        }
        if (failures <= 0) {
            console.log(`${GREEN}${CHECK}${NORMAL} SUCCESS: ${GREEN}${total} test(s)${NORMAL}.`);
        } else {
            console.log(`${RED}${CROSS}${NORMAL} FAIL: ${GRAY}${total} test(s), ${RED}${failures} failure(s)${NORMAL}.`);
            process.exit(-1);
        }
    } catch (e) {
        console.error('ERROR:', e.toString());
        process.exit(-1);
    }
}

const interact = async () => {
    let display = { buffer: '', refs: [] };

    const MAX_LOOKAHEAD = 3 * '[citation:x]'.length;

    const push = (display, text) => {
        let { buffer, refs } = display;
        buffer += text;
        let match;
        const PATTERN = /\[citation:(\d+)\]/g;
        while ((match = PATTERN.exec(buffer)) !== null) {
            const number = match[1];
            const { index } = match;
            if (number >= '0' && number <= '9') {
                const num = parseInt(number, 10);
                if (refs.indexOf(num) < 0) {
                    refs.push(num);
                }
                const citation = 1 + refs.indexOf(num);
                const ref = `${GRAY}[${citation}]${NORMAL}`;
                buffer = buffer.substr(0, index) + ref + buffer.substr(index + 12);
            }
        }
        if (buffer.length > MAX_LOOKAHEAD) {
            const output = buffer.substr(0, buffer.length - MAX_LOOKAHEAD);
            process.stdout.write(output);
            buffer = buffer.substr(buffer.length - MAX_LOOKAHEAD);
        }
        return { buffer, refs };
    }

    const flush = display => {
        const { buffer } = display;
        process.stdout.write(buffer.trimRight());
        return { buffer: '', refs: [] };
    }


    let history = [];

    let loop = true;
    const io = readline.createInterface({ input: process.stdin, output: process.stdout });
    io.on('close', () => { loop = false; });
    console.log();

    const qa = () => {
        io.question(`${YELLOW}>> ${CYAN}`, async (inquiry) => {
            process.stdout.write(NORMAL);
            if (inquiry === '!reset' || inquiry === '/reset') {
                history = [];
                console.log('History cleared.');
                console.log();
            } else if (inquiry === '!review' || inquiry === '/review') {
                const last = history.slice(-1).pop();
                if (!last) {
                    console.log('Nothing to review yet!');
                    console.log();
                } else {
                    const { stages } = last;
                    review(simplify(stages));
                }

            } else {
                const stages = [];
                const update = (stage, fields) => {
                    if (stage === 'Reason') {
                        const { keyphrases } = fields;
                        if (keyphrases && keyphrases.length > 0) {
                            console.log(`${GRAY}${ARROW} Searching for ${keyphrases}...${NORMAL}`);
                        }
                    }
                }
                const stream = (text) => display = push(display, text);
                const enter = (name) => { stages.push({ name, timestamp: Date.now() }) };
                const leave = (name, fields) => { update(name, fields); stages.push({ name, timestamp: Date.now(), ...fields }) };
                const delegates = { stream, enter, leave };
                const context = { inquiry, history, delegates };
                const start = Date.now();
                const pipeline = pipe(reason, search, respond);
                const result = await pipeline(context);
                const refs = display.refs.slice();
                display = flush(display);
                const { topic, thought, keyphrases } = result;
                const duration = Date.now() - start;
                const { answer, references } = result;
                if (references && Array.isArray(references) && references.length >= refs.length) {
                    console.log();
                    console.log();
                    refs.forEach((ref, i) => {
                        const { url } = references[ref - 1];
                        console.log(`[${i + 1}] ${GRAY}${url}${NORMAL}`);
                    });
                }
                history.push({ inquiry, thought, keyphrases, topic, answer, duration, stages });
                console.log();
                console.log();
            }
            loop && qa();
        })
    }

    qa();
}

const serve = async (port) => {
    let history = [];

    const decode = url => {
        const parsedUrl = new URL(`http://localhost/${url}`);
        const { search } = parsedUrl;
        return decodeURIComponent(search.substring(1)).trim();
    }

    const server = http.createServer(async (request, response) => {
        const { url } = request;
        if (url === '/health') {
            response.writeHead(200).end('OK');
        } else if (url === '/' || url === '/index.html') {
            response.writeHead(200, { 'Content-Type': 'text/html' });
            response.end(fs.readFileSync('./index.html'));
        } else if (url.startsWith('/chat')) {
            const inquiry = decode(url);
            if (inquiry === '/reset') {
                history = [];
                response.write('History cleared.');
                response.end();
            } else if (inquiry === '/review') {
                const last = history.slice(-1).pop();
                if (!last) {
                    response.write('Nothing to review yet!');
                } else {
                    const { stages } = last;
                    response.write(review(simplify(stages)));
                }
                response.end();
            } else if (inquiry.length > 0) {
                console.log(`${YELLOW}>> ${CYAN}${inquiry}${NORMAL}`);
                response.writeHead(200, { 'Content-Type': 'text/plain' });
                const stages = [];
                const enter = (name) => { stages.push({ name, timestamp: Date.now() }) };
                const leave = (name, fields) => { stages.push({ name, timestamp: Date.now(), ...fields }) };
                const stream = (text) => response.write(text);
                const delegates = { enter, leave, stream };
                const context = { inquiry, history, delegates };
                const start = Date.now();
                const pipeline = pipe(reason, search, respond);
                const result = await pipeline(context);
                response.end();
                const duration = Date.now() - start;
                const { topic, thought, keyphrases, answer } = result;
                history.push({ inquiry, thought, keyphrases, topic, answer, duration, stages });
                console.log(answer);
                console.log();
            } else {
                response.writeHead(400).end();
            }
        } else {
            console.error(`${url} is 404!`)
            response.writeHead(404);
            response.end();
        }
    });
    server.listen(port);
    console.log('Listening on port', port);
}

const poll = async () => {

    let state = {};

    const format = (answer, references) => {
        let buffer = answer;
        let refs = [];

        while (true) {
            const index = buffer.indexOf('[citation:');
            if (index < 0) {
                break;
            }
            const number = buffer[index + 10];
            if (number >= '0' && number <= '9') {
                const num = parseInt(number, 10);
                if (refs.indexOf(num) < 0) {
                    refs.push(num);
                }
                const citation = 1 + refs.indexOf(num);
                buffer = buffer.substr(0, index) + `[${citation}]` + buffer.substr(index + 12);
            }
        }

        if (references && Array.isArray(references) && references.length >= refs.length) {
            buffer += '\n\nReferences:\n';
            refs.forEach((ref, i) => {
                const { url } = references[ref - 1];
                buffer += `[${i + 1}] ${url}\n`;
            });
        }
        return buffer;
    }

    const check = async (offset) => {

        const POLL_URL = `https://api.telegram.org/bot${GAMAL_TELEGRAM_TOKEN}/getUpdates?offset=${offset}`;
        const SEND_URL = `https://api.telegram.org/bot${GAMAL_TELEGRAM_TOKEN}/sendMessage`;

        const send = async (id, message) => {
            try {
                await fetch(SEND_URL, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        chat_id: id,
                        text: message
                    })
                });
            } catch (error) {
                console.error(`Unable to send message to ${id}: ${error}`);
            }
        }

        const response = await fetch(POLL_URL);
        if (!response.ok) {
            console.error(`Error: ${response.status} ${response.statusText}`);
        } else {
            const data = await response.json();
            const { result } = data;
            result.forEach(async (update) => {
                const { message, update_id } = update;
                const { text, chat } = message;
                const history = state[chat.id] || [];
                offset = update_id + 1;
                if (text === '/reset') {
                    state[chat.id] = [];
                    send(chat.id, 'History cleared.');
                } else if (text === '/review') {
                    const last = history.slice(-1).pop();
                    if (!last) {
                        send(chat.id, 'Nothing to review yet!');
                    } else {
                        const { stages } = last;
                        send(chat.id, review(simplify(stages)));
                    }
                } else {
                    const stages = [];
                    const enter = (name) => { stages.push({ name, timestamp: Date.now() }) };
                    const leave = (name, fields) => { stages.push({ name, timestamp: Date.now(), ...fields }) };
                    const delegates = { enter, leave };
                    const inquiry = text;
                    console.log(`${YELLOW}>> ${CYAN}${inquiry}${NORMAL}`);
                    const context = { inquiry, history, delegates };
                    const start = Date.now();
                    const pipeline = pipe(reason, search, respond);
                    const result = await pipeline(context);
                    const duration = Date.now() - start;
                    const { topic, thought, keyphrases, references, answer } = result;
                    console.log(answer);
                    console.log();
                    history.push({ inquiry, thought, keyphrases, topic, references, answer, duration, stages });
                    state[chat.id] = history;
                    send(chat.id, format(answer, references));
                }
            })
        }

        setTimeout(() => { check(offset) }, 200);
    }

    check(0);
}


(async () => {
    if (!YOU_API_KEY || YOU_API_KEY.length < 64) {
        console.error('Fatal error: YOU_API_KEY not set!');
        process.exit(-1);
    }
    console.log(`Using LLM at ${LLM_API_BASE_URL} (model: ${GREEN}${LLM_CHAT_MODEL || 'default'}${NORMAL}).`);

    const args = process.argv.slice(2);
    args.forEach(evaluate);
    if (args.length == 0) {
        const port = parseInt(GAMAL_HTTP_PORT, 10);
        if (!Number.isNaN(port) && port > 0 && port < 65536) {
            await serve(port);
        } else if (GAMAL_TELEGRAM_TOKEN && GAMAL_TELEGRAM_TOKEN.length >= 40) {
            console.log('Running as a Telegram bot...');
            await poll();
        } else {
            await interact();
        }
    }
})();
