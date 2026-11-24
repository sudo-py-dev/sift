// Everything that comes from GitHub issues, PRs and comments is written by strangers.
// This module cleans that text before Claude or the browser sees it, fences it so it can't
// pose as instructions, and flags text that tries to steer an AI.
import crypto from 'node:crypto';

// Characters that hide or reorder text: zero-width, bidi overrides/isolates (Trojan Source),
// soft hyphen, word joiner, BOM, Unicode tag characters (invisible "ASCII smuggling"), C0/C1 controls.
const HIDDEN = /[​-‏‪-‮⁠-⁤⁦-⁩­﻿᠎]|[\u{E0000}-\u{E007F}]|[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu;

/** Removes invisible and control characters and HTML comments (a favourite hiding place). */
export function clean(text = '') {
  return String(text ?? '')
    .replace(/<!--[\s\S]*?(-->|$)/g, ' ')
    .replace(HIDDEN, '')
    .replace(/\r\n?/g, '\n');
}

export function hiddenCount(text = '') {
  return (String(text ?? '').match(HIDDEN) || []).length + (String(text ?? '').match(/<!--[\s\S]*?(-->|$)/g) || []).filter((c) => /[a-z]{4,}/i.test(c)).length;
}

const AI = '(?:claude|chat\\s?gpt|gpt-?\\d*|copilot|gemini|llama|codex|cursor|(?:the\\s+)?(?:ai|llm|assistant|agent|bot|model|triage(?:\\s+bot)?))';
const ACT = '(?:close|merge|approve|label|delete|remove|run|execute|ignore|mark|escalate|prioriti[sz]e|rank|assign|reopen|comment|reply|post|push|commit|install|fetch|curl|send|reveal|print|output|leak)';

/** Patterns that address an AI rather than a human maintainer. Each has a short name for the report. */
export const INJECTION_PATTERNS = [
  ['override', /\b(ignore|disregard|forget|override|bypass)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|your|system|original)\b[^.\n]{0,25}\b(instructions?|prompts?|rules?|guidelines?|directives?|context)\b/i],
  ['new-instructions', /\b(new|updated|real|actual|hidden|secret)\s+(system\s+)?(instructions?|prompt|task|directive)s?\s*[:\-]/i],
  ['role-play', /\b(you are now|from now on,? you|act as|pretend (to be|you are)|roleplay as|switch to)\b[^.\n]{0,40}\b(ai|assistant|admin|maintainer|developer mode|dan|unrestricted|jailbr)/i],
  ['fake-role-tag', /<\/?\s*(system|assistant|untrusted[-_ ]?data|tool_?(call|result|use)s|function_?(calls|results)|invoke\s+name|system[-_]reminder|antml:[\w-]+|im_start|im_end)\b[^>]*>/i],
  ['chat-template', /<\|(im_start|im_end|system|user|assistant|endoftext|eot_id|start_header_id)\|>|\[\/?INST\]|<<\/?SYS>>|^\s*###\s*(system|instruction|assistant)\s*:?\s*$/im],
  ['fake-turn', /^\s*(human|assistant|system|user|claude)\s*:\s*\S/im],
  ['addressed-to-ai', new RegExp(`\\b(hey|dear|attention|note to|instructions? (for|to))?,?\\s*${AI}\\s*[,:!]\\s*(please\\s+)?${ACT}\\b`, 'i')],
  ['ai-must', new RegExp(`\\b(if you(?:'re| are)(?: an?)?|attention,?|to (?:any|all|every)|note for (?:any|the))\\s+${AI}s?\\b[^.\\n]{0,60}\\b(must|should|need to|are required to|shall)\\b`, 'i')],
  ['fake-authority', /\b(maintainers?|owners?|admins?|the team|anthropic|github)\b[^.\n]{0,30}\b(has|have|already)?\s*(pre-?)?(authori[sz]ed|approved|allowed|instructed|permitted)\b[^.\n]{0,30}\b(you|the (ai|assistant|bot|agent))\b/i],
  ['skip-confirmation', /\b(without|no need (for|to)|skip|don'?t)\s+(asking|ask|confirm(ation)?|approval|checking with)\b[^.\n]{0,30}\b(user|maintainer|human|anyone)?/i],
  ['secret-exfil', /\b(gh\s+auth\s+token|GITHUB_TOKEN|ANTHROPIC_API_KEY|\.ssh\/id_|\.env\b|api[_ -]?key|access[_ -]?token|credentials?)\b[^.\n]{0,40}\b(print|reveal|send|post|include|paste|output|share|exfiltrat|upload)\b|\b(print|reveal|send|post|include|paste|output|share|exfiltrat|upload)\b[^.\n]{0,40}\b(gh\s+auth\s+token|GITHUB_TOKEN|ANTHROPIC_API_KEY|\.ssh\/id_|secrets?|api[_ -]?keys?|access[_ -]?tokens?|credentials?)\b/i],
  ['tool-command', /\b(run|execute|call)\b[^.\n]{0,20}`?\s*(gh\s+(issue|pr|repo|api|auth|secret)\b|curl\s|wget\s|rm\s+-rf|bash\s+-c|sh\s+-c|python\s+-c|node\s+-e)/i],
  ['encoded-payload', /\b(base64|rot13|hex)[-\s]?(decode|encoded)\b[^.\n]{0,40}\b(follow|execute|run|instructions?|obey)\b|\b(decode|follow|execute)\b[^.\n]{0,30}\b(base64|rot13)\b/i],
];

// Lookalike letters (Cyrillic, Greek) and fullwidth/stylised forms are folded to ASCII so "Ιgnore previous іnstructions" still matches.
const CONFUSABLE = { 'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x', 'і': 'i', 'ј': 'j', 'ѕ': 's', 'ԁ': 'd', 'ɡ': 'g', 'һ': 'h', 'ӏ': 'l', 'А': 'A', 'В': 'B', 'Е': 'E', 'К': 'K', 'М': 'M', 'Н': 'H', 'О': 'O', 'Р': 'P', 'С': 'C', 'Т': 'T', 'Х': 'X', 'І': 'I', 'Ј': 'J', 'Ѕ': 'S', 'Α': 'A', 'Β': 'B', 'Ε': 'E', 'Ζ': 'Z', 'Η': 'H', 'Ι': 'I', 'Κ': 'K', 'Μ': 'M', 'Ν': 'N', 'Ο': 'O', 'Ρ': 'P', 'Τ': 'T', 'Υ': 'Y', 'Χ': 'X', 'ο': 'o', 'ι': 'i', 'ν': 'v', 'α': 'a' };
export function normalize(t) {
  return t.normalize('NFKC').replace(/[\u0370-\u03FF\u0400-\u04FF\u0500-\u052F\u0261]/g, (c) => CONFUSABLE[c] ?? c);
}

// Weak patterns appear in ordinary bug reports too (curl commands, "User:" transcripts, token talk),
// so they only count in prose (code removed) that also addresses an AI.
const WEAK = new Set(['fake-turn', 'skip-confirmation', 'secret-exfil', 'tool-command']);
const MENTIONS_AI = new RegExp(`\\b${AI}\\b`, "i");
const stripCode = (t) => t.replace(/```[\s\S]*?(```|$)/g, ' ').replace(/~~~[\s\S]*?(~~~|$)/g, ' ').replace(/`[^`\n]*`/g, ' ').replace(/^( {4}|\t).*$/gm, ' ');

/** Returns the names of injection patterns found in the text (after cleaning). */
export function injectionFindings(...texts) {
  const found = new Set();
  for (const raw of texts) {
    // Check hidden places too: HTML comments stay in, invisible characters go, lookalike letters become plain ones.
    const t = normalize(String(raw ?? '').replace(HIDDEN, ''));
    if (!t.trim()) continue;
    const prose = stripCode(t);
    const aiTalk = MENTIONS_AI.test(prose);
    for (const [name, re] of INJECTION_PATTERNS) {
      if (WEAK.has(name)) { if (aiTalk && re.test(prose)) found.add(name); }
      else if (re.test(t)) found.add(name);
    }
  }
  return [...found];
}

/** A per-worksheet random fence: text inside can't guess it, so it can't close the block or forge new entries. */
export function makeFence() {
  const id = crypto.randomBytes(6).toString('hex');
  const open = `<untrusted-data id="${id}">`;
  const close = `</untrusted-data id="${id}">`;
  return {
    id,
    wrap(text) {
      const body = clean(text)
        .replace(/untrusted[-_ ]?data/gi, 'untrusted_data(text)')
        .replace(new RegExp(id, 'g'), '[id]')
        .replace(/^(#{1,6}\s)/gm, '\\$1'); // headings inside data can't pose as worksheet sections
      return `${open}\n${body}\n${close}`;
    },
  };
}
