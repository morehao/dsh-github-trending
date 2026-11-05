/**
 * 宿主 `@deepseek-ai/dsh-tools` 的 author DSL 规则子集（离线校验用）。
 *
 * 对照版本：dsh 0.2.1-rc.3 / rc.5 / 0.2.2-rc.1 的 `packages/core/tools/src/schema.ts`。
 * 规则很稳定，但宿主升级时仍需用真机冒烟兜底（见 docs）。
 *
 * 关键点：
 * - `parameters` 是属性映射，每个属性可内联 `required: true`；
 * - `output.schema` 是 value schema，**根节点不允许 `required: string[]`**；
 * - 每个 `type: 'object'` 节点必须显式声明 boolean 的 `additionalProperties`。
 */

const ANNOTATION_KEYS = new Set(['description', 'title', 'default', 'examples']);

function fail(path, message) {
  throw new Error(`${path}: ${message}`);
}

/**
 * 校验一个 value schema 节点。
 * @param {unknown} node
 * @param {string} path
 * @param {boolean} allowRequired 该节点是否允许内联 `required: true`（只有属性节点允许）
 */
function assertValue(node, path, allowRequired) {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    fail(path, 'must be a schema object');
  }
  const allowed = new Set([...ANNOTATION_KEYS, 'type', 'oneOf', 'properties', 'additionalProperties', 'items', 'enum', 'const']);
  if (allowRequired) allowed.add('required');
  for (const key of Object.keys(node)) {
    if (!allowed.has(key)) fail(path, `unsupported key "${key}" by the value schema DSL`);
  }
  if (allowRequired && 'required' in node && node.required !== true) {
    fail(`${path}.required`, 'must be true when present');
  }

  if ('oneOf' in node) {
    if (!Array.isArray(node.oneOf) || node.oneOf.length < 2) fail(`${path}.oneOf`, 'requires at least two branches');
    node.oneOf.forEach((branch, index) => assertValue(branch, `${path}.oneOf[${index}]`, false));
    return;
  }

  const type = node.type;
  if (type === 'json') return;
  if (type === 'object') {
    if (typeof node.additionalProperties !== 'boolean') {
      fail(`${path}.additionalProperties`, 'must be explicitly true or false');
    }
    for (const [key, child] of Object.entries(node.properties ?? {})) {
      assertValue(child, `${path}.properties.${key}`, true);
    }
    return;
  }
  if (type === 'array') {
    if ('items' in node) assertValue(node.items, `${path}.items`, false);
    return;
  }
  if (!['string', 'number', 'integer', 'boolean', 'null'].includes(type)) {
    fail(`${path}.type`, 'must be a supported scalar type, or object/array/json');
  }
}

/**
 * 校验一个 `defineTool` 入参的核心 schema 面。
 * @param {{ name?: string, parameters?: object, output?: { schema?: unknown } }} definition
 */
export function assertToolDefinition(definition) {
  if (!definition || typeof definition !== 'object') fail('definition', 'must be an object');
  if (typeof definition.name !== 'string' || definition.name.trim() === '') fail('definition.name', 'must be a non-empty string');
  if (!definition.output || typeof definition.output !== 'object') fail('definition.output', 'is required');
  if (typeof definition.output.render !== 'function') fail('definition.output.render', 'must be a function');

  // 根节点：不允许 required 数组
  assertValue(definition.output.schema, 'output.schema', false);

  // 参数映射：每个属性允许内联 required
  const parameters = definition.parameters ?? {};
  if (parameters === null || typeof parameters !== 'object' || Array.isArray(parameters)) {
    fail('parameters', 'must be a property map');
  }
  for (const [key, child] of Object.entries(parameters)) {
    assertValue(child, `parameters.${key}`, true);
  }
}
