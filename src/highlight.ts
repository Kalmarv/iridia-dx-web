// Syntax colouring by line: each language a list of token rules, longest-first by order. A line's tokens are spans,
// so a pane can mark whole lines (cross-highlighting) without re-tokenising.

export type Lang = 'hlsl' | 'wgsl' | 'ir' | 'listing' | 'asm' | 'llvm' | 'plain';

interface Rule { re: RegExp; cls: string }

const num = { re: /^(?:0x[0-9a-fA-F]+|[-+]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][-+]?\d+)?)[fFhHuUiIlL]*/, cls: 'num' };
const ws = { re: /^\s+/, cls: '' };
const ident = { re: /^[A-Za-z_][A-Za-z0-9_]*/, cls: 'id' };
const punct = { re: /^[^\sA-Za-z0-9_]/, cls: 'p' };

const words = (list: string) => new Set(list.split(/\s+/).filter(Boolean));

const HLSL_KW = words(`if else for while do return break continue discard switch case default struct cbuffer tbuffer
  register packoffset static const uniform in out inout void true false typedef row_major column_major
  groupshared numthreads unroll loop branch flatten SamplerState sampler2D sampler Texture2D RWTexture2D
  StructuredBuffer RWStructuredBuffer Buffer unorm snorm`);
const HLSL_TY = /^(?:float|half|int|uint|bool|double|min16float|dword)(?:[1-4](?:x[1-4])?)?$/;
const HLSL_FN = words(`mul dot cross normalize length lerp saturate sin cos tan pow exp exp2 log log2 sqrt rsqrt abs
  min max clamp step smoothstep frac floor ceil reflect refract tex2D tex2Dlod Sample SampleLevel Load ddx ddy
  fmod sign any all asfloat asuint distance`);

const WGSL_KW = words(`fn let var const return if else loop for while break continue continuing switch case
  default discard struct alias override enable true false`);
const WGSL_TY = /^(?:f32|f16|i32|u32|bool|vec[234]|mat[234]x[234]|array|atomic|ptr|sampler|sampler_comparison|texture_\w+)$/;

const IR_OPS = /^(?:input|output|buffer|sample|compose|select|return|kill|demote|fadd|fsub|fmul|fdiv|fma|fmin|fmax|fneg|fabs|dot|iadd|isub|imul|and|or|xor|not|shl|shr|ushr|cmp|eq|ne|lt|le|gt|ge|bitcast|convert|saturate|state|if|else|loop|break|continue|fn|phi|rcp|rsq|sqrt|exp2|log2|sin|cos|floor|ceil|fract|round|trunc|frc|deriv\w*|load|store|swizzle|extract|insert|constant|literal)\b/;

const LISTING_REG = /^(?:[rvoxtcsbuisp](?:\d+)|o(?:Pos|Fog|Pts|D|C|T)\d*|oDepth|vFace|vPos|aL|a0|p0|cb\d+|icb|l|mov|dcl_\w+)/;

function tokenize(line: string, lang: Lang): [string, string][] {
  const out: [string, string][] = [];
  let rest = line;
  const push = (text: string, cls: string) => {
    if (out.length && out[out.length - 1][1] === cls) out[out.length - 1][0] += text;
    else out.push([text, cls]);
  };
  // a comment runs to the end of the line: `;` in assembly and LLVM, `//` elsewhere
  const comment = lang === 'asm' || lang === 'llvm' ? /^;.*$/ : /^\/\/.*$/;
  while (rest.length) {
    const c = rest.match(comment);
    if (c) {
      push(c[0], 'com');
      break;
    }
    const str = rest.match(/^"(?:[^"\\]|\\.)*"/);
    if (str) {
      push(str[0], 'str');
      rest = rest.slice(str[0].length);
      continue;
    }
    if (lang === 'hlsl' && rest[0] === '#') {
      push(rest, 'pre');
      break;
    }
    if (lang === 'wgsl' && rest[0] === '@') {
      const m = rest.match(/^@[A-Za-z_]+/);
      if (m) {
        push(m[0], 'attr');
        rest = rest.slice(m[0].length);
        continue;
      }
    }
    if (lang === 'ir' && rest[0] === '%') {
      const m = rest.match(/^%\d+/);
      if (m) {
        push(m[0], 'val');
        rest = rest.slice(m[0].length);
        continue;
      }
    }
    if (lang === 'llvm' && (rest[0] === '%' || rest[0] === '@' || rest[0] === '!')) {
      const m = rest.match(/^[%@!][-A-Za-z0-9_.$]+/);
      if (m) {
        push(m[0], rest[0] === '!' ? 'meta' : 'val');
        rest = rest.slice(m[0].length);
        continue;
      }
    }
    let matched = false;
    for (const rule of [ws, num, ident, punct] as Rule[]) {
      const m = rest.match(rule.re);
      if (!m) continue;
      let cls = rule.cls;
      const t = m[0];
      if (rule === ident) cls = classify(t, lang, rest.slice(t.length));
      push(t, cls);
      rest = rest.slice(t.length);
      matched = true;
      break;
    }
    if (!matched) {
      push(rest[0], '');
      rest = rest.slice(1);
    }
  }
  return out;
}

function classify(t: string, lang: Lang, after: string): string {
  const call = /^\s*\(/.test(after);
  switch (lang) {
    case 'hlsl':
      if (HLSL_KW.has(t)) return 'kw';
      if (HLSL_TY.test(t)) return 'ty';
      if (/^(?:SV_\w+|TEXCOORD\d*|POSITION\d*|NORMAL\d*|TANGENT\d*|COLOR\d*|BINORMAL\d*)$/.test(t)) return 'sem';
      if (HLSL_FN.has(t) || call) return 'fn';
      return 'id';
    case 'wgsl':
      if (WGSL_KW.has(t)) return 'kw';
      if (WGSL_TY.test(t)) return 'ty';
      if (call) return 'fn';
      return 'id';
    case 'ir':
      if (t === 'iridia' || t === 'fn' || t === 'main') return 'kw';
      if (WGSL_TY.test(t)) return 'ty';
      if (IR_OPS.test(t)) return 'fn';
      return 'id';
    case 'llvm':
      if (/^(?:define|declare|call|ret|br|label|phi|load|store|alloca|getelementptr|fadd|fsub|fmul|fdiv|add|sub|mul|and|or|xor|icmp|fcmp|select|bitcast|zext|sext|trunc|fptoui|fptosi|uitofp|sitofp|extractvalue|insertvalue|switch|unreachable|to|void|float|half|double|i1|i8|i16|i32|i64|type|target|attributes|metadata|nounwind|readnone|readonly|align|fast|nnan|ninf|nsz|arcp|contract|reassoc|afn)$/.test(t))
        return 'kw';
      return 'id';
    case 'listing':
    case 'asm':
      if (LISTING_REG.test(t) && /\d$/.test(t)) return 'reg';
      if (/^(?:ps|vs|cs|gs|hs|ds)_\d_\d$/.test(t)) return 'kw';
      if (/^(?:dcl\w*|def\w*|if\w*|else|endif|loop|endloop|rep|endrep|break\w*|ret\w*|call\w*|label)$/.test(t)) return 'kw';
      return 'op';
    default:
      return 'id';
  }
}

/** The lines of `text` as coloured `<span>`s, one element per line. */
export function highlightLines(text: string, lang: Lang): HTMLElement[] {
  return text.split('\n').map((line) => {
    const el = document.createElement('span');
    el.className = 'ln';
    if (lang === 'plain') {
      el.textContent = line;
    } else {
      for (const [t, cls] of tokenize(line, lang)) {
        if (!cls || cls === 'id' || cls === 'p') {
          el.appendChild(document.createTextNode(t));
        } else {
          const s = document.createElement('span');
          s.className = 't-' + cls;
          s.textContent = t;
          el.appendChild(s);
        }
      }
    }
    if (!line) el.appendChild(document.createTextNode(' '));
    return el;
  });
}

/** The listing's language: DXIL's LLVM assembly, or a DXBC or Direct3D 9 listing. */
export const listingLang = (format: string): Lang => (format === 'dxil' ? 'llvm' : 'listing');
