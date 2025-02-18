// Ported from js-yaml v3.13.1:
// https://github.com/nodeca/js-yaml/commit/665aadda42349dcae869f12040d9b10ef18d12da
// Copyright 2011-2015 by Vitaly Puzrin. All rights reserved. MIT license.
// Copyright 2018-2024 the Deno authors. All rights reserved. MIT license.

import {
  AMPERSAND,
  ASTERISK,
  COLON,
  COMMA,
  COMMERCIAL_AT,
  DOUBLE_QUOTE,
  EXCLAMATION,
  GRAVE_ACCENT,
  GREATER_THAN,
  isWhiteSpace,
  LEFT_CURLY_BRACKET,
  LEFT_SQUARE_BRACKET,
  LINE_FEED,
  MINUS,
  PERCENT,
  QUESTION,
  RIGHT_CURLY_BRACKET,
  RIGHT_SQUARE_BRACKET,
  SHARP,
  SINGLE_QUOTE,
  VERTICAL_LINE,
} from "./_chars.ts";
import { DEFAULT_SCHEMA, type Schema } from "./_schema.ts";
import type { KindType, StyleVariant, Type } from "./_type.ts";
import { type ArrayObject, getObjectTypeString, isObject } from "./_utils.ts";

const STYLE_PLAIN = 1;
const STYLE_SINGLE = 2;
const STYLE_LITERAL = 3;
const STYLE_FOLDED = 4;
const STYLE_DOUBLE = 5;

const LEADING_SPACE_REGEXP = /^\n* /;

const ESCAPE_SEQUENCES = new Map<number, string>([
  [0x00, "\\0"],
  [0x07, "\\a"],
  [0x08, "\\b"],
  [0x09, "\\t"],
  [0x0a, "\\n"],
  [0x0b, "\\v"],
  [0x0c, "\\f"],
  [0x0d, "\\r"],
  [0x1b, "\\e"],
  [0x22, '\\"'],
  [0x5c, "\\\\"],
  [0x85, "\\N"],
  [0xa0, "\\_"],
  [0x2028, "\\L"],
  [0x2029, "\\P"],
]);

const DEPRECATED_BOOLEANS_SYNTAX = [
  "y",
  "Y",
  "yes",
  "Yes",
  "YES",
  "on",
  "On",
  "ON",
  "n",
  "N",
  "no",
  "No",
  "NO",
  "off",
  "Off",
  "OFF",
];

/**
 * Encodes a Unicode character code point as a hexadecimal escape sequence.
 */
function charCodeToHexString(charCode: number): string {
  const hexString = charCode.toString(16).toUpperCase();
  if (charCode <= 0xff) return `\\x${hexString.padStart(2, "0")}`;
  if (charCode <= 0xffff) return `\\u${hexString.padStart(4, "0")}`;
  if (charCode <= 0xffffffff) return `\\U${hexString.padStart(8, "0")}`;
  throw new Error(
    "Code point within a string may not be greater than 0xFFFFFFFF",
  );
}

function compileStyleMap(
  map?: ArrayObject<StyleVariant> | null,
): ArrayObject<StyleVariant> {
  if (typeof map === "undefined" || map === null) return {};

  const result: ArrayObject<StyleVariant> = {};
  for (let tag of Object.keys(map)) {
    const style = String(map[tag]) as StyleVariant;
    if (tag.slice(0, 2) === "!!") {
      tag = `tag:yaml.org,2002:${tag.slice(2)}`;
    }
    result[tag] = style;
  }

  return result;
}

// Indents every line in a string. Empty lines (\n only) are not indented.
function indentString(string: string, spaces: number): string {
  const indent = " ".repeat(spaces);
  return string
    .split("\n")
    .map((line) => line.length ? indent + line : line)
    .join("\n");
}

function generateNextLine(indent: number, level: number): string {
  return `\n${" ".repeat(indent * level)}`;
}

function testImplicitResolving(
  implicitTypes: Type<"scalar">[],
  str: string,
): boolean {
  return implicitTypes.some((type) => type.resolve(str));
}

// Returns true if the character can be printed without escaping.
// From YAML 1.2: "any allowed characters known to be non-printable
// should also be escaped. [However,] This isn’t mandatory"
// Derived from nb-char - \t - #x85 - #xA0 - #x2028 - #x2029.
function isPrintable(c: number): boolean {
  return (
    (0x00020 <= c && c <= 0x00007e) ||
    (0x000a1 <= c && c <= 0x00d7ff && c !== 0x2028 && c !== 0x2029) ||
    (0x0e000 <= c && c <= 0x00fffd && c !== 0xfeff) /* BOM */ ||
    (0x10000 <= c && c <= 0x10ffff)
  );
}

// Simplified test for values allowed after the first character in plain style.
function isPlainSafe(c: number): boolean {
  // Uses a subset of nb-char - c-flow-indicator - ":" - "#"
  // where nb-char ::= c-printable - b-char - c-byte-order-mark.
  return (
    isPrintable(c) &&
    c !== 0xfeff &&
    // - c-flow-indicator
    c !== COMMA &&
    c !== LEFT_SQUARE_BRACKET &&
    c !== RIGHT_SQUARE_BRACKET &&
    c !== LEFT_CURLY_BRACKET &&
    c !== RIGHT_CURLY_BRACKET &&
    // - ":" - "#"
    c !== COLON &&
    c !== SHARP
  );
}

// Simplified test for values allowed as the first character in plain style.
function isPlainSafeFirst(c: number): boolean {
  // Uses a subset of ns-char - c-indicator
  // where ns-char = nb-char - s-white.
  return (
    isPrintable(c) &&
    c !== 0xfeff &&
    !isWhiteSpace(c) && // - s-white
    // - (c-indicator ::=
    // “-” | “?” | “:” | “,” | “[” | “]” | “{” | “}”
    c !== MINUS &&
    c !== QUESTION &&
    c !== COLON &&
    c !== COMMA &&
    c !== LEFT_SQUARE_BRACKET &&
    c !== RIGHT_SQUARE_BRACKET &&
    c !== LEFT_CURLY_BRACKET &&
    c !== RIGHT_CURLY_BRACKET &&
    // | “#” | “&” | “*” | “!” | “|” | “>” | “'” | “"”
    c !== SHARP &&
    c !== AMPERSAND &&
    c !== ASTERISK &&
    c !== EXCLAMATION &&
    c !== VERTICAL_LINE &&
    c !== GREATER_THAN &&
    c !== SINGLE_QUOTE &&
    c !== DOUBLE_QUOTE &&
    // | “%” | “@” | “`”)
    c !== PERCENT &&
    c !== COMMERCIAL_AT &&
    c !== GRAVE_ACCENT
  );
}

// Determines whether block indentation indicator is required.
function needIndentIndicator(string: string): boolean {
  return LEADING_SPACE_REGEXP.test(string);
}

// Determines which scalar styles are possible and returns the preferred style.
// lineWidth = -1 => no limit.
// Pre-conditions: str.length > 0.
// Post-conditions:
//  STYLE_PLAIN or STYLE_SINGLE => no \n are in the string.
//  STYLE_LITERAL => no lines are suitable for folding (or lineWidth is -1).
//  STYLE_FOLDED => a line > lineWidth and can be folded (and lineWidth !== -1).
function chooseScalarStyle(
  string: string,
  singleLineOnly: boolean,
  indentPerLevel: number,
  lineWidth: number,
  testAmbiguousType: (string: string) => boolean,
): number {
  const shouldTrackWidth = lineWidth !== -1;
  let hasLineBreak = false;
  let hasFoldableLine = false; // only checked if shouldTrackWidth
  let previousLineBreak = -1; // count the first line correctly
  let plain = isPlainSafeFirst(string.charCodeAt(0)) &&
    !isWhiteSpace(string.charCodeAt(string.length - 1));

  let char: number;
  let i: number;
  if (singleLineOnly) {
    // Case: no block styles.
    // Check for disallowed characters to rule out plain and single.
    for (i = 0; i < string.length; i++) {
      char = string.charCodeAt(i);
      if (!isPrintable(char)) {
        return STYLE_DOUBLE;
      }
      plain = plain && isPlainSafe(char);
    }
  } else {
    // Case: block styles permitted.
    for (i = 0; i < string.length; i++) {
      char = string.charCodeAt(i);
      if (char === LINE_FEED) {
        hasLineBreak = true;
        // Check if any line can be folded.
        if (shouldTrackWidth) {
          hasFoldableLine = hasFoldableLine ||
            // Foldable line = too long, and not more-indented.
            (i - previousLineBreak - 1 > lineWidth &&
              string[previousLineBreak + 1] !== " ");
          previousLineBreak = i;
        }
      } else if (!isPrintable(char)) {
        return STYLE_DOUBLE;
      }
      plain = plain && isPlainSafe(char);
    }
    // in case the end is missing a \n
    hasFoldableLine = hasFoldableLine ||
      (shouldTrackWidth &&
        i - previousLineBreak - 1 > lineWidth &&
        string[previousLineBreak + 1] !== " ");
  }
  // Although every style can represent \n without escaping, prefer block styles
  // for multiline, since they're more readable and they don't add empty lines.
  // Also prefer folding a super-long line.
  if (!hasLineBreak && !hasFoldableLine) {
    // Strings interpretable as another type have to be quoted;
    // e.g. the string 'true' vs. the boolean true.
    return plain && !testAmbiguousType(string) ? STYLE_PLAIN : STYLE_SINGLE;
  }
  // Edge case: block indentation indicator can only have one digit.
  if (indentPerLevel > 9 && needIndentIndicator(string)) {
    return STYLE_DOUBLE;
  }
  // At this point we know block styles are valid.
  // Prefer literal style unless we want to fold.
  return hasFoldableLine ? STYLE_FOLDED : STYLE_LITERAL;
}

// Greedy line breaking.
// Picks the longest line under the limit each time,
// otherwise settles for the shortest line over the limit.
// NB. More-indented lines *cannot* be folded, as that would add an extra \n.
function foldLine(line: string, width: number): string {
  if (line === "" || line[0] === " ") return line;

  // Since a more-indented line adds a \n, breaks can't be followed by a space.
  const breakRegExp = / [^ ]/g; // note: the match index will always be <= length-2.
  // start is an inclusive index. end, curr, and next are exclusive.
  let start = 0;
  let end;
  let curr = 0;
  let next = 0;
  const lines = [];

  // Invariants: 0 <= start <= length-1.
  //   0 <= curr <= next <= max(0, length-2). curr - start <= width.
  // Inside the loop:
  //   A match implies length >= 2, so curr and next are <= length-2.
  for (const match of line.matchAll(breakRegExp)) {
    next = match.index;
    // maintain invariant: curr - start <= width
    if (next - start > width) {
      end = curr > start ? curr : next; // derive end <= length-2
      lines.push(line.slice(start, end));
      // skip the space that was output as \n
      start = end + 1; // derive start <= length-1
    }
    curr = next;
  }

  // By the invariants, start <= length-1, so there is something left over.
  // It is either the whole string or a part starting from non-whitespace.
  // Insert a break if the remainder is too long and there is a break available.
  if (line.length - start > width && curr > start) {
    lines.push(line.slice(start, curr));
    lines.push(line.slice(curr + 1));
  } else {
    lines.push(line.slice(start));
  }

  return lines.join("\n");
}

function trimTrailingNewline(string: string) {
  return string.at(-1) === "\n" ? string.slice(0, -1) : string;
}

// Note: a long line without a suitable break point will exceed the width limit.
// Pre-conditions: every char in str isPrintable, str.length > 0, width > 0.
function foldString(string: string, width: number): string {
  // In folded style, $k$ consecutive newlines output as $k+1$ newlines—
  // unless they're before or after a more-indented line, or at the very
  // beginning or end, in which case $k$ maps to $k$.
  // Therefore, parse each chunk as newline(s) followed by a content line.
  const lineRe = /(\n+)([^\n]*)/g;

  // first line (possibly an empty line)
  let result = ((): string => {
    let nextLF = string.indexOf("\n");
    nextLF = nextLF !== -1 ? nextLF : string.length;
    lineRe.lastIndex = nextLF;
    return foldLine(string.slice(0, nextLF), width);
  })();
  // If we haven't reached the first content line yet, don't add an extra \n.
  let prevMoreIndented = string[0] === "\n" || string[0] === " ";
  let moreIndented;

  // rest of the lines
  let match;
  // tslint:disable-next-line:no-conditional-assignment
  while ((match = lineRe.exec(string))) {
    const prefix = match[1];
    const line = match[2] || "";
    moreIndented = line[0] === " ";
    result += prefix +
      (!prevMoreIndented && !moreIndented && line !== "" ? "\n" : "") +
      foldLine(line, width);
    prevMoreIndented = moreIndented;
  }

  return result;
}

// Escapes a double-quoted string.
function escapeString(string: string): string {
  let result = "";
  let char;
  let nextChar;
  let escapeSeq;

  for (let i = 0; i < string.length; i++) {
    char = string.charCodeAt(i);
    // Check for surrogate pairs (reference Unicode 3.0 section "3.7 Surrogates").
    if (char >= 0xd800 && char <= 0xdbff /* high surrogate */) {
      nextChar = string.charCodeAt(i + 1);
      if (nextChar >= 0xdc00 && nextChar <= 0xdfff /* low surrogate */) {
        // Combine the surrogate pair and store it escaped.
        result += charCodeToHexString(
          (char - 0xd800) * 0x400 + nextChar - 0xdc00 + 0x10000,
        );
        // Advance index one extra since we already used that char here.
        i++;
        continue;
      }
    }
    escapeSeq = ESCAPE_SEQUENCES.get(char);
    result += !escapeSeq && isPrintable(char)
      ? string[i]
      : escapeSeq || charCodeToHexString(char);
  }

  return result;
}

// Pre-conditions: string is valid for a block scalar, 1 <= indentPerLevel <= 9.
function blockHeader(string: string, indentPerLevel: number): string {
  const indentIndicator = needIndentIndicator(string)
    ? String(indentPerLevel)
    : "";

  // note the special case: the string '\n' counts as a "trailing" empty line.
  const clip = string[string.length - 1] === "\n";
  const keep = clip && (string[string.length - 2] === "\n" || string === "\n");
  const chomp = keep ? "+" : clip ? "" : "-";

  return `${indentIndicator}${chomp}\n`;
}

function inspectNode(
  object: unknown,
  objects: unknown[],
  duplicateObjects: Set<unknown>,
) {
  if (!isObject(object)) return;
  if (objects.includes(object)) {
    duplicateObjects.add(object);
    return;
  }
  objects.push(object);
  const entries = Array.isArray(object) ? object : Object.values(object);
  for (const value of entries) {
    inspectNode(value, objects, duplicateObjects);
  }
}

export interface DumperStateOptions {
  /** indentation width to use (in spaces). */
  indent?: number;
  /** when true, adds an indentation level to array elements */
  arrayIndent?: boolean;
  /**
   * do not throw on invalid types (like function in the safe schema)
   * and skip pairs and single values with such types.
   */
  skipInvalid?: boolean;
  /**
   * specifies level of nesting, when to switch from
   * block to flow style for collections. -1 means block style everywhere
   */
  flowLevel?: number;
  /** Each tag may have own set of styles.	- "tag" => "style" map. */
  styles?: ArrayObject<StyleVariant> | null;
  /** specifies a schema to use. */
  schema?: Schema;
  /**
   * If true, sort keys when dumping YAML in ascending, ASCII character order.
   * If a function, use the function to sort the keys. (default: false)
   * If a function is specified, the function must return a negative value
   * if first argument is less than second argument, zero if they're equal
   * and a positive value otherwise.
   */
  sortKeys?: boolean | ((a: string, b: string) => number);
  /** set max line width. (default: 80) */
  lineWidth?: number;
  /**
   * if false, don't convert duplicate objects
   * into references (default: true)
   */
  useAnchors?: boolean;
  /**
   * if false don't try to be compatible with older yaml versions.
   * Currently: don't quote "yes", "no" and so on,
   * as required for YAML 1.1 (default: true)
   */
  compatMode?: boolean;
  /**
   * if true flow sequences will be condensed, omitting the
   * space between `key: value` or `a, b`. Eg. `'[a,b]'` or `{a:{b:c}}`.
   * Can be useful when using yaml for pretty URL query params
   * as spaces are %-encoded. (default: false).
   */
  condenseFlow?: boolean;
}

export class DumperState {
  schema: Schema;
  indent: number;
  arrayIndent: boolean;
  skipInvalid: boolean;
  flowLevel: number;
  sortKeys: boolean | ((a: string, b: string) => number);
  lineWidth: number;
  useAnchors: boolean;
  compatMode: boolean;
  condenseFlow: boolean;
  implicitTypes: Type<"scalar">[];
  explicitTypes: Type<KindType>[];
  duplicates: unknown[] = [];
  usedDuplicates: Set<unknown> = new Set();
  styleMap: ArrayObject<StyleVariant>;

  constructor({
    schema = DEFAULT_SCHEMA,
    indent = 2,
    arrayIndent = true,
    skipInvalid = false,
    flowLevel = -1,
    styles = undefined,
    sortKeys = false,
    lineWidth = 80,
    useAnchors = true,
    compatMode = true,
    condenseFlow = false,
  }: DumperStateOptions) {
    this.schema = schema;
    this.indent = Math.max(1, indent);
    this.arrayIndent = arrayIndent;
    this.skipInvalid = skipInvalid;
    this.flowLevel = flowLevel;
    this.styleMap = compileStyleMap(styles);
    this.sortKeys = sortKeys;
    this.lineWidth = lineWidth;
    this.useAnchors = useAnchors;
    this.compatMode = compatMode;
    this.condenseFlow = condenseFlow;
    this.implicitTypes = this.schema.implicitTypes;
    this.explicitTypes = this.schema.explicitTypes;
  }

  // Note: line breaking/folding is implemented for only the folded style.
  // NB. We drop the last trailing newline (if any) of a returned block scalar
  //  since the dumper adds its own newline. This always works:
  //    • No ending newline => unaffected; already using strip "-" chomping.
  //    • Ending newline    => removed then restored.
  //  Importantly, this keeps the "+" chomp indicator from gaining an extra line.
  stringifyScalar(string: string, level: number, isKey: boolean): string {
    if (string.length === 0) {
      return "''";
    }
    if (this.compatMode && DEPRECATED_BOOLEANS_SYNTAX.includes(string)) {
      return `'${string}'`;
    }

    const indent = this.indent * Math.max(1, level); // no 0-indent scalars
    // As indentation gets deeper, let the width decrease monotonically
    // to the lower bound min(this.lineWidth, 40).
    // Note that this implies
    //  this.lineWidth ≤ 40 + this.indent: width is fixed at the lower bound.
    //  this.lineWidth > 40 + this.indent: width decreases until the lower
    //  bound.
    // This behaves better than a constant minimum width which disallows
    // narrower options, or an indent threshold which causes the width
    // to suddenly increase.
    const lineWidth = this.lineWidth === -1
      ? -1
      : Math.max(Math.min(this.lineWidth, 40), this.lineWidth - indent);

    // Without knowing if keys are implicit/explicit,
    // assume implicit for safety.
    const singleLineOnly = isKey ||
      // No block styles in flow mode.
      (this.flowLevel > -1 && level >= this.flowLevel);

    switch (
      chooseScalarStyle(
        string,
        singleLineOnly,
        this.indent,
        lineWidth,
        (str: string): boolean =>
          testImplicitResolving(this.implicitTypes, str),
      )
    ) {
      case STYLE_PLAIN:
        return string;
      case STYLE_SINGLE:
        return `'${string.replace(/'/g, "''")}'`;
      case STYLE_LITERAL:
        return `|${blockHeader(string, this.indent)}${
          trimTrailingNewline(indentString(string, indent))
        }`;
      case STYLE_FOLDED:
        return `>${blockHeader(string, this.indent)}${
          trimTrailingNewline(
            indentString(foldString(string, lineWidth), indent),
          )
        }`;
      case STYLE_DOUBLE:
        return `"${escapeString(string)}"`;
      default:
        throw new TypeError("impossible error: invalid scalar style");
    }
  }

  stringifyFlowSequence(object: unknown[], level: number): string {
    let result = "";
    for (let index = 0; index < object.length; index += 1) {
      // Write only valid elements.
      const string = this.stringifyNode(level, object[index], {
        block: false,
        compact: false,
        isKey: false,
      });
      if (string === null) continue;
      if (index !== 0) result += `,${!this.condenseFlow ? " " : ""}`;
      result += string;
    }

    return `[${result}]`;
  }

  stringifyBlockSequence(
    object: unknown[],
    level: number,
    compact: boolean,
  ): string {
    let result = "";

    for (let index = 0; index < object.length; index += 1) {
      // Write only valid elements.
      const string = this.stringifyNode(level + 1, object[index], {
        block: true,
        compact: true,
        isKey: false,
      });
      if (string !== null) {
        if (!compact || index !== 0) {
          result += generateNextLine(this.indent, level);
        }

        if (string && LINE_FEED === string.charCodeAt(0)) {
          result += "-";
        } else {
          result += "- ";
        }

        result += string;
      }
    }

    return result || "[]"; // Empty sequence if no valid values.
  }

  stringifyFlowMapping(object: Record<string, unknown>, level: number): string {
    let result = "";
    const objectKeyList = Object.keys(object);

    for (const [index, objectKey] of objectKeyList.entries()) {
      let pairBuffer = this.condenseFlow ? '"' : "";

      if (index !== 0) pairBuffer += ", ";

      const objectValue = object[objectKey];

      const keyString = this.stringifyNode(level, objectKey, {
        block: false,
        compact: false,
        isKey: false,
      });
      if (
        keyString === null
      ) {
        continue; // Skip this pair because of invalid key;
      }

      if (keyString.length > 1024) pairBuffer += "? ";

      pairBuffer += `${keyString}${this.condenseFlow ? '"' : ""}:${
        this.condenseFlow ? "" : " "
      }`;

      const valueString = this.stringifyNode(level, objectValue, {
        block: false,
        compact: false,
        isKey: false,
      });

      if (valueString === null) {
        continue; // Skip this pair because of invalid value.
      }

      pairBuffer += valueString;

      // Both key and value are valid.
      result += pairBuffer;
    }

    return `{${result}}`;
  }

  stringifyBlockMapping(
    object: Record<string, unknown>,
    tag: string | null,
    level: number,
    compact: boolean,
  ): string {
    const objectKeyList = Object.keys(object);
    let result = "";

    // Allow sorting keys so that the output file is deterministic
    if (this.sortKeys === true) {
      // Default sorting
      objectKeyList.sort();
    } else if (typeof this.sortKeys === "function") {
      // Custom sort function
      objectKeyList.sort(this.sortKeys);
    } else if (this.sortKeys) {
      // Something is wrong
      throw new TypeError("sortKeys must be a boolean or a function");
    }

    for (const [index, objectKey] of objectKeyList.entries()) {
      let pairBuffer = "";

      if (!compact || index !== 0) {
        pairBuffer += generateNextLine(this.indent, level);
      }

      const objectValue = object[objectKey];

      const keyString = this.stringifyNode(level + 1, objectKey, {
        block: true,
        compact: true,
        isKey: true,
      });
      if (keyString === null) {
        continue; // Skip this pair because of invalid key.
      }

      const explicitPair = (tag !== null && tag !== "?") ||
        (keyString.length > 1024);

      if (explicitPair) {
        if (keyString && LINE_FEED === keyString.charCodeAt(0)) {
          pairBuffer += "?";
        } else {
          pairBuffer += "? ";
        }
      }

      pairBuffer += keyString;

      if (explicitPair) {
        pairBuffer += generateNextLine(this.indent, level);
      }

      const valueString = this.stringifyNode(level + 1, objectValue, {
        block: true,
        compact: explicitPair,
        isKey: false,
      });
      if (
        valueString === null
      ) {
        continue; // Skip this pair because of invalid value.
      }

      if (valueString && LINE_FEED === valueString.charCodeAt(0)) {
        pairBuffer += ":";
      } else {
        pairBuffer += ": ";
      }

      pairBuffer += valueString;

      // Both key and value are valid.
      result += pairBuffer;
    }

    return result || "{}"; // Empty mapping if no valid pairs.
  }

  detectType(
    object: unknown,
    explicit: boolean,
  ): { tag: string; object: unknown } | null {
    const typeList = explicit ? this.explicitTypes : this.implicitTypes;

    let tag = null;
    for (const type of typeList) {
      if (type.predicate?.(object)) {
        tag = explicit ? type.tag : "?";

        if (type.represent) {
          const style = this.styleMap[type.tag]! || type.defaultStyle;

          if (typeof type.represent === "function") {
            object = type.represent(object, style);
            return { tag, object };
          }
          if (Object.hasOwn(type.represent, style)) {
            object = type.represent[style]!(object, style);
            return { tag, object };
          }
          throw new TypeError(
            `!<${type.tag}> tag resolver accepts not "${style}" style`,
          );
        }

        return { tag, object };
      }
    }
    return null;
  }

  // Serializes `object` and writes it to global `result`.
  // Returns true on success, or false on invalid object.
  stringifyNode(level: number, object: unknown, { block, compact, isKey }: {
    block: boolean;
    compact: boolean;
    isKey: boolean;
  }): string | null {
    const result = this.detectType(object, false) ??
      this.detectType(object, true) ?? { tag: null, object };
    const tag = result.tag;
    object = result.object;

    if (block) {
      block = this.flowLevel < 0 || this.flowLevel > level;
    }

    const objectOrArray = isObject(object) ||
      Array.isArray(object);

    let duplicateIndex = -1;
    let duplicate = false;
    if (objectOrArray) {
      duplicateIndex = this.duplicates.indexOf(object);
      duplicate = duplicateIndex !== -1;
    }

    if (
      (tag !== null && tag !== "?") ||
      duplicate ||
      (this.indent !== 2 && level > 0)
    ) {
      compact = false;
    }

    if (duplicate && this.usedDuplicates.has(object)) {
      return `*ref_${duplicateIndex}`;
    } else {
      if (objectOrArray && duplicate) {
        this.usedDuplicates.add(object);
      }
      if (isObject(object) && !Array.isArray(object)) {
        if (block && Object.keys(object).length !== 0) {
          object = this.stringifyBlockMapping(object, tag, level, compact);
          if (duplicate) {
            object = `&ref_${duplicateIndex}${object}`;
          }
        } else {
          object = this.stringifyFlowMapping(object, level);
          if (duplicate) {
            object = `&ref_${duplicateIndex} ${object}`;
          }
        }
      } else if (Array.isArray(object)) {
        const arrayLevel = !this.arrayIndent && level > 0 ? level - 1 : level;
        if (block && object.length !== 0) {
          object = this.stringifyBlockSequence(object, arrayLevel, compact);
          if (duplicate) {
            object = `&ref_${duplicateIndex}${object}`;
          }
        } else {
          object = this.stringifyFlowSequence(object, arrayLevel);
          if (duplicate) {
            object = `&ref_${duplicateIndex} ${object}`;
          }
        }
      } else if (typeof object === "string") {
        if (tag !== "?") {
          object = this.stringifyScalar(object, level, isKey);
        }
      } else {
        if (this.skipInvalid) return null;
        throw new TypeError(
          `unacceptable kind of an object to dump ${
            getObjectTypeString(object)
          }`,
        );
      }

      if (tag !== null && tag !== "?") {
        object = `!<${tag}> ${object}`;
      }
    }

    return object as string;
  }

  getDuplicateReferences(object: unknown) {
    const objects: unknown[] = [];
    const duplicateObjects: Set<unknown> = new Set();

    inspectNode(object, objects, duplicateObjects);

    for (const object of duplicateObjects) this.duplicates.push(object);
    this.usedDuplicates = new Set();
  }

  stringify(data: unknown): string {
    if (this.useAnchors) this.getDuplicateReferences(data);

    const string = this.stringifyNode(0, data, {
      block: true,
      compact: true,
      isKey: false,
    });
    if (string !== null) {
      return `${string}\n`;
    }
    return "";
  }
}
