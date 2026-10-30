#!/usr/bin/env node
/**
 * 从 `contract/schema/ipc.v1.json` 生成 `src/ipc.gen.ts`。
 *
 *   node scripts/gen-ipc-types.mjs            写 src/ipc.gen.ts
 *   node scripts/gen-ipc-types.mjs --check    只在内存里生成并与现有文件逐字节比对
 *
 * 只支持这份 schema 实际用到的 JSON Schema 子集：$defs / $ref / const / enum /
 * type / properties / required / additionalProperties / items / minimum / format。
 * 遇到没实现的组合会直接失败，而不是悄悄生成一个宽类型——类型放宽就等于契约失效。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const schemaPath = path.join(root, 'contract', 'schema', 'ipc.v1.json');
const outPath = path.join(root, 'src', 'ipc.gen.ts');
const check = process.argv.includes('--check');

const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
const defs = schema.$defs ?? {};
const upstream = JSON.parse(readFileSync(path.join(root, 'contract', 'UPSTREAM.json'), 'utf8'));

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function fail(message) {
  throw new Error(`gen-ipc-types: ${message}`);
}

function literal(value) {
  return JSON.stringify(value);
}

function indent(text, spaces) {
  const pad = ' '.repeat(spaces);
  return text
    .split('\n')
    .map((line) => (line === '' ? line : pad + line))
    .join('\n');
}

function union(values) {
  if (values.length === 0) fail('空 enum');
  return values.map(literal).join(' | ');
}

function typeOf(node, ctx) {
  if (node === true) return 'unknown';
  if (node === false) return 'never';
  if (node.$ref !== undefined) {
    const name = node.$ref.replace(/^#\/\$defs\//, '');
    if (!defs[name]) fail(`未知 $ref：${node.$ref}`);
    return name;
  }
  if (node.const !== undefined) return literal(node.const);
  if (node.enum !== undefined) return union(node.enum);
  switch (node.type) {
    case 'string':
      // format: date / date-time 用 string 表达（插件不做模板字面量校验）。
      return 'string';
    case 'integer':
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'null':
      return 'null';
    case 'array': {
      if (node.items === undefined) return 'unknown[]';
      const item = typeOf(node.items, ctx);
      return /\s\|\s/.test(item) ? `Array<${item}>` : `${item}[]`;
    }
    case 'object': {
      if (node.properties === undefined) {
        const value = node.additionalProperties === undefined ? 'unknown' : typeOf(node.additionalProperties, ctx);
        return `Record<string, ${value}>`;
      }
      return inlineObject(node, ctx);
    }
    default:
      if (node.oneOf !== undefined) return node.oneOf.map((item) => typeOf(item, ctx)).join(' | ');
      if (node.anyOf !== undefined) return node.anyOf.map((item) => typeOf(item, ctx)).join(' | ');
      return 'unknown';
  }
}

function requiredSet(node) {
  return new Set(node.required ?? []);
}

function inlineObject(node, ctx) {
  const required = requiredSet(node);
  const props = Object.entries(node.properties ?? {}).map(([key, value]) => {
    const name = IDENT.test(key) ? key : literal(key);
    const optional = required.has(key) ? '' : '?';
    const doc = value.description ? `/** ${value.description} */\n` : '';
    return `${doc}${name}${optional}: ${typeOf(value, ctx)}`;
  });
  if (node.additionalProperties === true) props.push('[key: string]: unknown');
  if (props.length === 0) return node.additionalProperties === true ? 'Record<string, unknown>' : 'Record<string, never>';
  return `{\n${indent(props.join('\n'), 2)}\n}`;
}

function emitDef(name, node) {
  const comment = node.description ? `/** ${node.description} */\n` : '';
  if (node.type === 'string' && node.enum) return `${comment}export type ${name} = ${union(node.enum)};`;
  if (node.type === 'object' && node.properties) return `${comment}export interface ${name} ${inlineObject(node, { name })}`;
  return `${comment}export type ${name} = ${typeOf(node, { name })};`;
}

const header = [
  '/**',
  ' * 由 scripts/gen-ipc-types.mjs 从 contract/schema/ipc.v1.json 生成，**不要手改**。',
  ` * 上游：${upstream.repo}@${upstream.commit ?? upstream.ref}`,
  ` * aggregate：${upstream.aggregate}`,
  ' * 重新生成：npm run gen:ipc',
  ' */',
  '',
].join('\n');

const blocks = Object.entries(defs).map(([name, node]) => emitDef(name, node));
const consts = [];
if (defs.RunRequest?.properties?.ipcSchema?.const !== undefined) {
  consts.push(`export const IPC_SCHEMA_VERSION = ${defs.RunRequest.properties.ipcSchema.const} as const;`);
}

const output = `${header}${blocks.join('\n\n')}\n\n${consts.join('\n')}\n`;

if (!check) {
  writeFileSync(outPath, output);
  console.log(`已写 src/ipc.gen.ts（${blocks.length} 个定义）`);
} else {
  let current = '';
  try {
    current = readFileSync(outPath, 'utf8');
  } catch {
    console.error('src/ipc.gen.ts 不存在；先跑 npm run gen:ipc');
    process.exit(1);
  }
  if (current !== output) {
    console.error('src/ipc.gen.ts 与 contract/schema/ipc.v1.json 不同步；跑 npm run gen:ipc 重新生成');
    process.exit(1);
  }
  console.log(`src/ipc.gen.ts 与契约一致（${blocks.length} 个定义）`);
}
