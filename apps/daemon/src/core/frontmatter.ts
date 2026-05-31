export type FrontmatterScalar = string | number | boolean | null;
export type FrontmatterValue = FrontmatterScalar | FrontmatterArray | FrontmatterObject;
export interface FrontmatterArray extends Array<FrontmatterValue> {}
export interface FrontmatterObject extends Record<string, FrontmatterValue> {}

type FrontmatterContainer = FrontmatterObject | FrontmatterArray;

interface StackEntry {
  indent: number;
  container: FrontmatterContainer;
  key: string | null;
}

export interface ParsedFrontmatter {
  data: FrontmatterObject;
  body: string;
}

export function parseFrontmatter(source: string): ParsedFrontmatter {
  const text = source.replace(/^\uFEFF/, '');
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(text);
  if (!match) {
    return { data: {}, body: text };
  }

  return {
    data: parseYamlSubset(match[1] ?? ''),
    body: match[2] ?? '',
  };
}

function parseYamlSubset(source: string): FrontmatterObject {
  const lines = source.split(/\r?\n/);
  const root: FrontmatterObject = {};
  const stack: StackEntry[] = [{ indent: -1, container: root, key: null }];
  let index = 0;

  while (index < lines.length) {
    const raw = lines[index] ?? '';
    if (/^\s*(?:#.*)?$/.test(raw)) {
      index += 1;
      continue;
    }

    const indent = leadingWhitespaceLength(raw);
    while (stack.length > 1 && indent <= stack[stack.length - 1]!.indent) {
      stack.pop();
    }

    const current = stack[stack.length - 1]!;
    const line = raw.slice(indent);

    if (line.startsWith('- ')) {
      parseArrayItem(line.slice(2), current, stack);
      index += 1;
      continue;
    }

    const keyValue = /^([^:]+):\s*(.*)$/.exec(line);
    if (!keyValue) {
      index += 1;
      continue;
    }

    const key = (keyValue[1] ?? '').trim();
    const value = keyValue[2] ?? '';
    if (!key || Array.isArray(current.container)) {
      index += 1;
      continue;
    }

    if (isBlockLiteralMarker(value)) {
      const block = collectBlockLiteral(lines, index + 1, indent + 2);
      current.container[key] = block.value;
      index = block.nextIndex;
      continue;
    }

    if (value === '') {
      const child: FrontmatterObject = {};
      current.container[key] = child;
      stack.push({ indent, container: child, key });
      index += 1;
      continue;
    }

    current.container[key] = coerceValue(value);
    index += 1;
  }

  return root;
}

function parseArrayItem(value: string, current: StackEntry, stack: StackEntry[]): void {
  let container = current.container;
  if (!Array.isArray(container)) {
    const parent = stack[stack.length - 2];
    if (!parent || !current.key || Array.isArray(parent.container)) {
      return;
    }

    const array: FrontmatterArray = [];
    parent.container[current.key] = array;
    current.container = array;
    container = array;
  }

  container.push(coerceValue(value.trim()));
}

function collectBlockLiteral(
  lines: string[],
  startIndex: number,
  childIndent: number,
): { value: string; nextIndex: number } {
  const collected: string[] = [];
  let index = startIndex;

  while (index < lines.length) {
    const next = lines[index] ?? '';
    if (/^\s*$/.test(next)) {
      collected.push('');
      index += 1;
      continue;
    }

    const indent = leadingWhitespaceLength(next);
    if (indent < childIndent) {
      break;
    }

    collected.push(next.slice(childIndent));
    index += 1;
  }

  return {
    value: collected.join('\n').trimEnd(),
    nextIndex: index,
  };
}

function isBlockLiteralMarker(value: string): boolean {
  return value === '|' || value === '|-' || value === '>' || value === '>-';
}

function leadingWhitespaceLength(value: string): number {
  return value.match(/^\s*/)?.[0].length ?? 0;
}

function coerceValue(raw: string): FrontmatterValue {
  const value = raw.trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null' || value === '~') return null;

  if (/^-?\d+$/.test(value) || /^-?\d*\.\d+$/.test(value)) {
    return Number(value);
  }

  if (value === '[]') {
    return [];
  }

  if (value.startsWith('[') && value.endsWith(']')) {
    return value
      .slice(1, -1)
      .split(',')
      .map((item) => coerceValue(item))
      .filter((item) => item !== '');
  }

  return value;
}
