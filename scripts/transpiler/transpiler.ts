import ts from 'typescript';

export interface TranspilerOptions {
  stripDataView?: boolean;
  headerInclude?: string;
  companionFile?: string;
}

export interface TranspileResult {
  cSource: string;
  hHeader: string;
  hasExports: boolean;
}

/**
 * Maps TypeScript type names to C native types.
 */
export function mapTsTypeToC(typeText?: string, paramName?: string): string {
  if (!typeText) {
    if (paramName && (paramName.endsWith('_idx') || paramName.includes('count') || paramName.includes('size'))) {
      return 'int32_t';
    }
    return 'uint32_t';
  }

  const cleaned = typeText.trim();
  if (cleaned.includes('|') && (cleaned.includes('DataView') || cleaned.includes('Uint8Array'))) {
    return 'uint32_t';
  }
  switch (cleaned) {
    case 'u8':
      return 'uint8_t';
    case 'u16':
      return 'uint16_t';
    case 'u32':
      return 'uint32_t';
    case 'i8':
      return 'int8_t';
    case 'i16':
      return 'int16_t';
    case 'i32':
      return 'int32_t';
    case 'u64':
      return 'uint64_t';
    case 'i64':
    case 'bigint':
      return 'int64_t';
    case 'f64':
      return 'double';
    case 'byte_ptr':
      return 'uint32_t';
    case 'const_u8_ptr':
      return 'const uint8_t *';
    case 'u8_ptr':
      return 'uint8_t *';
    case 'const_char_ptr':
      return 'const char *';
    case 'char_ptr':
      return 'char *';
    case 'boolean':
    case 'c_bool':
      if (paramName === 'buf_pool_is_dirty') {
        return 'int32_t';
      }
      return 'bool';
    case 'string':
      if (paramName && paramName.startsWith('out_')) {
        return 'char *';
      }
      return 'const char *';
    case 'Uint8Array':
    case 'DataView':
      if (paramName && paramName.startsWith('source')) {
        return 'const uint8_t *';
      }
      return 'uint8_t *';
    case 'any':
      if (paramName && paramName.startsWith('out_')) {
        return 'char *';
      }
      return 'void *';
    case 'void':
      return 'void';
    case 'number':
      if (paramName && (paramName.startsWith('slot') || paramName.endsWith('_idx') || paramName === 'res')) {
        return 'int32_t';
      }
      return 'uint32_t';
    default:
      return cleaned;
  }
}

export class TsToCTranspiler {
  private indentLevel = 0;
  private options: TranspilerOptions;
  private exportedSignatures: string[] = [];
  private exportedStructs: string[] = [];
  private hasAnyExportC: boolean = false;
  private aliasMap: Map<string, string> = new Map();

  constructor(options: TranspilerOptions = {}) {
    this.options = {
      stripDataView: true,
      ...options,
    };
  }

  private indent(): string {
    return '  '.repeat(this.indentLevel);
  }

  public transpile(tsCode: string, fileName: string = 'module.c.ts'): TranspileResult {
    this.indentLevel = 0;
    this.exportedSignatures = [];
    this.exportedStructs = [];
    this.aliasMap.clear();
    this.hasAnyExportC = tsCode.includes('@export_c');

    const sourceFile = ts.createSourceFile(
      fileName,
      tsCode,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );

    // Pre-scan statements to discover aliases (@use_c: target or @manual_c: target)
    for (const statement of sourceFile.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name) {
        const fullText = statement.getFullText();
        const commentText = fullText.slice(0, statement.getStart() - statement.getFullStart());
        const aliasMatch = commentText.match(/@(use_c|manual_c|native_c):\s*([a-zA-Z0-9_]+)/);
        if (aliasMatch) {
          this.aliasMap.set(statement.name.text, aliasMatch[2]);
        }
      }
    }

    // Extract top-level @c_include directives
    const customIncludes: string[] = [];
    const includeRegex = /@c_include\s+["<]([^">]+)[">]/g;
    let incMatch: RegExpExecArray | null;
    while ((incMatch = includeRegex.exec(tsCode)) !== null) {
      customIncludes.push(`#include "${incMatch[1]}"`);
    }

    // Extract top-level @c_raw blocks
    const rawBlocks: string[] = [];
    const rawRegex = /@c_raw\s*```c\s*([\s\S]*?)```/g;
    let rawMatch: RegExpExecArray | null;
    while ((rawMatch = rawRegex.exec(tsCode)) !== null) {
      rawBlocks.push(rawMatch[1].trim());
    }

    const baseName = fileName.replace(/\.c\.ts$/, '').replace(/\.ts$/, '').replace(/\./g, '_');
    const headerName = `${baseName}.h`;

    const bodyParts: string[] = [];

    for (const statement of sourceFile.statements) {
      if (ts.isInterfaceDeclaration(statement)) {
        const name = statement.name.text;
        const members = statement.members.map((m) => {
          if (ts.isPropertySignature(m) && m.name) {
            const propName = m.name.getText();
            const propType = mapTsTypeToC(m.type?.getText(), propName);
            return `  ${propType} ${propName};`;
          }
          return '';
        }).filter(Boolean);
        this.exportedStructs.push(`typedef struct {\n${members.join('\n')}\n} ${name};`);
        continue;
      }
      if (!ts.isFunctionDeclaration(statement) && !ts.isVariableStatement(statement)) {
        continue;
      }
      const emitted = this.emitStatement(statement);
      if (emitted) {
        bodyParts.push(emitted);
      }
    }

    const includeSection = [
      `#include "${this.options.headerInclude ?? headerName}"`,
      ...customIncludes,
    ];

    const companionSection = this.options.companionFile ? [
      ``,
      `// Include companion manual implementation`,
      `#include "${this.options.companionFile}"`,
    ] : [];

    const cSource = [
      `/**`,
      ` * WebDB C Core Engine - Automatically generated by WebDB TS->C Transpiler`,
      ` * Source: ${fileName}`,
      ` */`,
      ``,
      ...includeSection,
      ...(rawBlocks.length > 0 ? ['', ...rawBlocks] : []),
      ``,
      bodyParts.filter(Boolean).join('\n\n'),
      ...companionSection,
      ``,
    ].join('\n');

    const headerGuard = `WEBDB_${baseName.toUpperCase()}_H`;
    const hHeader = [
      `#ifndef ${headerGuard}`,
      `#define ${headerGuard}`,
      ``,
      `#include "webdb_types.h"`,
      ``,
      ...this.exportedStructs,
      ...(this.exportedStructs.length > 0 ? [''] : []),
      ...this.exportedSignatures.map((sig) => `${sig};`),
      ``,
      `#endif // ${headerGuard}`,
      ``,
    ].join('\n');

    return {
      cSource,
      hHeader,
      hasExports: this.exportedSignatures.length > 0 || this.exportedStructs.length > 0,
    };
  }

  private currentFunctionReturnType: string = '';

  private emitStatement(node: ts.Statement): string {
    if (ts.isFunctionDeclaration(node)) {
      return this.emitFunctionDeclaration(node);
    }
    if (ts.isVariableStatement(node)) {
      return this.emitVariableStatement(node);
    }
    if (ts.isIfStatement(node)) {
      return this.emitIfStatement(node);
    }
    if (ts.isForStatement(node)) {
      return this.emitForStatement(node);
    }
    if (ts.isWhileStatement(node)) {
      return this.emitWhileStatement(node);
    }
    if (ts.isSwitchStatement(node)) {
      return this.emitSwitchStatement(node);
    }
    if (ts.isReturnStatement(node)) {
      if (!node.expression) {
        if (this.currentFunctionReturnType === 'int32_t') {
          return `${this.indent()}return 0;`;
        }
        return `${this.indent()}return;`;
      }
      return `${this.indent()}return ${this.emitExpression(node.expression)};`;
    }
    if (ts.isBreakStatement(node)) {
      return `${this.indent()}break;`;
    }
    if (ts.isContinueStatement(node)) {
      return `${this.indent()}continue;`;
    }
    if (ts.isExpressionStatement(node)) {
      const expr = this.emitExpression(node.expression);
      if (expr.trim()) {
        return `${this.indent()}${expr};`;
      }
      return '';
    }
    if (ts.isThrowStatement(node)) {
      // In freestanding C, convert throw to error return
      return `${this.indent()}return -1;`;
    }
    if (ts.isBlock(node)) {
      return this.emitBlock(node);
    }
    if (ts.isTryStatement(node)) {
      return this.emitBlock(node.tryBlock);
    }
    if (ts.isEmptyStatement(node)) {
      return '';
    }
    return '';
  }

  private emitSwitchStatement(node: ts.SwitchStatement): string {
    const expr = this.emitExpression(node.expression);
    let out = `${this.indent()}switch (${expr}) {\n`;
    this.indentLevel++;
    for (const clause of node.caseBlock.clauses) {
      if (ts.isCaseClause(clause)) {
        const caseExpr = this.emitExpression(clause.expression);
        out += `${this.indent()}case ${caseExpr}:\n`;
      } else {
        out += `${this.indent()}default:\n`;
      }
      this.indentLevel++;
      for (const s of clause.statements) {
        const emitted = this.emitStatement(s);
        if (emitted) out += `${emitted}\n`;
      }
      this.indentLevel--;
    }
    this.indentLevel--;
    out += `${this.indent()}}`;
    return out;
  }

  private emitFunctionDeclaration(node: ts.FunctionDeclaration): string {
    if (!node.name) return '';
    const fnName = node.name.text;
    const isExported = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    const fullText = node.getFullText();
    const commentText = fullText.slice(0, node.getStart() - node.getFullStart());

    const isManualC = /@(manual_c|native_c|use_c|skip_transpile)/.test(commentText);
    const hasExportC = commentText.includes('@export_c');
    const hasInternalC = commentText.includes('@internal_c');

    // If module has @export_c annotations, filter out any function not marked with @export_c, @internal_c, or @manual_c
    if (this.hasAnyExportC && !hasExportC && !hasInternalC && !isManualC) {
      return '';
    }

    const cFnName = this.aliasMap.get(fnName) ?? fnName;

    let returnType = mapTsTypeToC(node.type?.getText(), fnName);
    const bodyText = node.body?.getText() ?? '';
    const hasError = bodyText.includes('throw ') || bodyText.includes('return -1;') || bodyText.includes('return -');
    if ((returnType === 'void' || returnType === 'uint32_t') && hasError) {
      returnType = 'int32_t';
    }
    this.currentFunctionReturnType = returnType;

    const params: string[] = [];
    for (const param of node.parameters) {
      const paramName = param.name.getText();
      const paramType = param.type?.getText();
      if (paramName === 'replacement' || (paramType && paramType.includes('{'))) {
        continue; // Skip host-only optional object parameters
      }
      if (this.options.stripDataView && (paramName === 'view' || paramName === 'dirty_mask')) {
        continue; // In C freestanding, global engine view/dirty_mask are flatly addressed
      }
      const cType = mapTsTypeToC(paramType, paramName);
      params.push(`${cType} ${paramName}`);
    }

    const paramStr = params.length > 0 ? params.join(', ') : 'void';
    const funcSig = `${returnType} ${cFnName}(${paramStr})`;
    const signature = `${(isExported || hasExportC) ? '' : 'static '}${funcSig}`;

    if (isExported || hasExportC) {
      this.exportedSignatures.push(`WEBDB_EXPORT ${funcSig}`);
    }

    if (isManualC) {
      // Check if there is an inline C code block in the comments
      const cBlockMatch = commentText.match(/```c\s*([\s\S]*?)```/);
      if (cBlockMatch) {
        return cBlockMatch[1].trim();
      }
      // No inline C block: function body provided manually in companion C file or extern.
      return '';
    }

    const body = node.body ? this.emitBlock(node.body) : ';';

    return `${signature} ${body}`;
  }

  private emitVariableStatement(node: ts.VariableStatement): string {
    const parts: string[] = [];
    const isTopLevel = this.indentLevel === 0;
    const isConst = (node.declarationList.flags & ts.NodeFlags.Const) !== 0;

    for (const decl of node.declarationList.declarations) {
      const varName = decl.name.getText();
      const explicitType = decl.type?.getText();
      const init = decl.initializer ? this.emitExpression(decl.initializer) : undefined;
      let cType = mapTsTypeToC(explicitType, varName);

      if (!explicitType && decl.initializer) {
        if (
          decl.initializer.kind === ts.SyntaxKind.TrueKeyword ||
          decl.initializer.kind === ts.SyntaxKind.FalseKeyword
        ) {
          cType = 'bool';
        }
      }

      if (decl.initializer && ts.isNewExpression(decl.initializer)) {
        const ctor = decl.initializer.expression.getText();
        if (ctor === 'Uint8Array') {
          const firstArg = decl.initializer.arguments?.[0];
          if (firstArg && ts.isArrayLiteralExpression(firstArg)) {
            parts.push(`static const uint8_t ${varName}[] = ${this.emitExpression(firstArg)};`);
            continue;
          }
          const size = firstArg ? this.emitExpression(firstArg) : '256';
          parts.push(`${isTopLevel ? 'static ' : ''}uint8_t ${varName}[${size}];`);
          continue;
        }
        if (ctor === 'Uint32Array') {
          const firstArg = decl.initializer.arguments?.[0];
          if (firstArg && ts.isArrayLiteralExpression(firstArg)) {
            parts.push(`static const uint32_t ${varName}[] = ${this.emitExpression(firstArg)};`);
            continue;
          }
          const size = firstArg ? this.emitExpression(firstArg) : '256';
          parts.push(`${isTopLevel ? 'static ' : ''}uint32_t ${varName}[${size}];`);
          continue;
        }
        if (ctor === 'DataView') {
          parts.push(`uint32_t ${varName} = 0;`);
          continue;
        }
      }

      if (isTopLevel) {
        if (isConst && init) {
          if (decl.initializer && ts.isStringLiteral(decl.initializer)) {
            parts.push(`static const char ${varName}[] = ${init};`);
          } else if (
            decl.initializer &&
            (ts.isNumericLiteral(decl.initializer) ||
              decl.initializer.kind === ts.SyntaxKind.TrueKeyword ||
              decl.initializer.kind === ts.SyntaxKind.FalseKeyword)
          ) {
            parts.push(`#ifndef ${varName}\n#define ${varName} ${init}\n#endif`);
          }
        } else {
          parts.push(`static ${cType} ${varName} = ${init ?? '0'};`);
        }
      } else if (init) {
        parts.push(`${cType} ${varName} = ${init};`);
      } else {
        parts.push(`${cType} ${varName};`);
      }
    }
    return `${this.indent()}${parts.join(`\n${this.indent()}`)}`;
  }

  private emitBlock(block: ts.Block): string {
    this.indentLevel++;
    const stmts: string[] = [];
    for (const s of block.statements) {
      const emitted = this.emitStatement(s);
      if (emitted) stmts.push(emitted);
    }
    this.indentLevel--;
    return `{\n${stmts.join('\n')}\n${this.indent()}}`;
  }

  private emitIfStatement(node: ts.IfStatement): string {
    const condText = node.expression.getText();
    if (condText.includes('replacement')) {
      if (node.elseStatement) {
        return this.emitStatement(node.elseStatement);
      }
      return '';
    }
    if (condText.includes('=== undefined') || condText.includes('== undefined')) {
      return '';
    }

    const cond = this.emitExpression(node.expression);
    let out = `${this.indent()}if (${cond}) `;
    if (ts.isBlock(node.thenStatement)) {
      out += this.emitBlock(node.thenStatement);
    } else {
      this.indentLevel++;
      out += `\n${this.emitStatement(node.thenStatement)}`;
      this.indentLevel--;
    }

    if (node.elseStatement) {
      out += ` else `;
      if (ts.isBlock(node.elseStatement) || ts.isIfStatement(node.elseStatement)) {
        out += this.emitStatement(node.elseStatement);
      } else {
        this.indentLevel++;
        out += `\n${this.emitStatement(node.elseStatement)}`;
        this.indentLevel--;
      }
    }
    return out;
  }

  private emitForStatement(node: ts.ForStatement): string {
    let initStr = '';
    if (node.initializer) {
      if (ts.isVariableDeclarationList(node.initializer)) {
        const decls = node.initializer.declarations.map((d) => {
          const varName = d.name.getText();
          const init = d.initializer ? this.emitExpression(d.initializer) : '0';
          const cType = mapTsTypeToC(d.type?.getText(), varName);
          return `${cType} ${varName} = ${init}`;
        });
        initStr = decls.join(', ');
      } else {
        initStr = this.emitExpression(node.initializer);
      }
    }

    const condStr = node.condition ? this.emitExpression(node.condition) : '';
    const incrStr = node.incrementor ? this.emitExpression(node.incrementor) : '';

    const header = `${this.indent()}for (${initStr}; ${condStr}; ${incrStr}) `;
    if (ts.isBlock(node.statement)) {
      return header + this.emitBlock(node.statement);
    } else {
      this.indentLevel++;
      const body = `\n${this.emitStatement(node.statement)}`;
      this.indentLevel--;
      return header + body;
    }
  }

  private emitWhileStatement(node: ts.WhileStatement): string {
    let cond = this.emitExpression(node.expression);
    if (cond === 'true') cond = '1';
    const header = `${this.indent()}while (${cond}) `;
    if (ts.isBlock(node.statement)) {
      return header + this.emitBlock(node.statement);
    } else {
      this.indentLevel++;
      const body = `\n${this.emitStatement(node.statement)}`;
      this.indentLevel--;
      return header + body;
    }
  }

  private emitExpression(expr: ts.Expression): string {
    if (ts.isAsExpression(expr) || ts.isNonNullExpression(expr) || ts.isTypeAssertionExpression(expr)) {
      return this.emitExpression(expr.expression);
    }
    if (ts.isBinaryExpression(expr)) {
      return this.emitBinaryExpression(expr);
    }
    if (ts.isPrefixUnaryExpression(expr)) {
      const op = ts.tokenToString(expr.operator) ?? '';
      return `${op}${this.emitExpression(expr.operand)}`;
    }
    if (ts.isPostfixUnaryExpression(expr)) {
      const op = ts.tokenToString(expr.operator) ?? '';
      return `${this.emitExpression(expr.operand)}${op}`;
    }
    if (ts.isParenthesizedExpression(expr)) {
      return `(${this.emitExpression(expr.expression)})`;
    }
    if (ts.isCallExpression(expr)) {
      return this.emitCallExpression(expr);
    }
    if (ts.isPropertyAccessExpression(expr)) {
      return this.emitPropertyAccess(expr);
    }
    if (ts.isElementAccessExpression(expr)) {
      return `${this.emitExpression(expr.expression)}[${this.emitExpression(expr.argumentExpression)}]`;
    }
    if (ts.isConditionalExpression(expr)) {
      const cond = this.emitExpression(expr.condition);
      const whenTrue = this.emitExpression(expr.whenTrue);
      const whenFalse = this.emitExpression(expr.whenFalse);
      return `${cond} ? ${whenTrue} : ${whenFalse}`;
    }
    if (ts.isArrayLiteralExpression(expr)) {
      const elems = expr.elements.map((e) => this.emitExpression(e));
      return `{ ${elems.join(', ')} }`;
    }
    if (ts.isObjectLiteralExpression(expr)) {
      const props = expr.properties
        .map((p) => {
          if (ts.isPropertyAssignment(p)) {
            return `.${p.name.getText()} = ${this.emitExpression(p.initializer)}`;
          }
          return '';
        })
        .filter(Boolean);
      const castType = this.currentFunctionReturnType && this.currentFunctionReturnType !== 'void'
        ? `(${this.currentFunctionReturnType})`
        : '';
      return `${castType}{ ${props.join(', ')} }`;
    }
    if (ts.isBigIntLiteral(expr)) {
      return `${expr.text.replace(/n$/, '')}LL`;
    }
    if (ts.isNewExpression(expr)) {
      if (expr.expression.getText() === 'DataView') {
        return '0';
      }
    }
    if (ts.isIdentifier(expr)) {
      const text = expr.text;
      if (this.aliasMap.has(text)) return this.aliasMap.get(text)!;
      if (text === 'true') return 'true';
      if (text === 'false') return 'false';
      if (text === 'null' || text === 'undefined') return '0';
      if (this.options.stripDataView && (text === 'dirty_mask' || text === 'view')) return '0';
      return text;
    }
    if (ts.isNumericLiteral(expr)) {
      return expr.text;
    }
    if (ts.isStringLiteral(expr)) {
      return JSON.stringify(expr.text);
    }
    return expr.getText();
  }

  private emitBinaryExpression(expr: ts.BinaryExpression): string {
    const left = this.emitExpression(expr.left);
    const right = this.emitExpression(expr.right);
    const opToken = expr.operatorToken.kind;

    // Handle JS bitwise unsigned shift zero: `(x >>> 0)` -> `(uint32_t)(x)`
    if (opToken === ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken) {
      if (right === '0') {
        return `(uint32_t)(${left})`;
      }
      return `((uint32_t)(${left}) >> ${right})`;
    }

    switch (opToken) {
      case ts.SyntaxKind.EqualsEqualsEqualsToken:
        return `${left} == ${right}`;
      case ts.SyntaxKind.ExclamationEqualsEqualsToken:
        return `${left} != ${right}`;
      case ts.SyntaxKind.EqualsEqualsToken:
        return `${left} == ${right}`;
      case ts.SyntaxKind.ExclamationEqualsToken:
        return `${left} != ${right}`;
      default:
        const op = ts.tokenToString(opToken) ?? '';
        return `${left} ${op} ${right}`;
    }
  }

  private emitCallExpression(expr: ts.CallExpression): string {
    const calleeText = expr.expression.getText();

    // c_inline compile-time intrinsic
    if (calleeText === 'c_inline' && expr.arguments.length >= 1) {
      const firstArg = expr.arguments[0];
      if (ts.isStringLiteral(firstArg)) {
        return firstArg.text;
      }
    }

    // c_assert
    if (calleeText === 'c_assert' && expr.arguments.length >= 1) {
      const cond = this.emitExpression(expr.arguments[0]);
      if (this.currentFunctionReturnType === 'void') {
        return `if (!(${cond})) return`;
      }
      return `if (!(${cond})) return -1`;
    }

    // Map Math.imul(a, b) -> (a * b)
    if (calleeText === 'Math.imul' && expr.arguments.length === 2) {
      const a = this.emitExpression(expr.arguments[0]);
      const b = this.emitExpression(expr.arguments[1]);
      return `(${a} * ${b})`;
    }

    // str.charCodeAt(i) -> str[i]
    if (calleeText.endsWith('.charCodeAt') && expr.arguments.length === 1 && ts.isPropertyAccessExpression(expr.expression)) {
      const obj = this.emitExpression(expr.expression.expression);
      const idx = this.emitExpression(expr.arguments[0]);
      return `${obj}[${idx}]`;
    }

    // BigInt(x) -> ((uint64_t)(x))
    if (calleeText === 'BigInt' && expr.arguments.length === 1) {
      return `((uint64_t)(${this.emitExpression(expr.arguments[0])}))`;
    }

    // Number(x) -> ((uint32_t)(x))
    if (calleeText === 'Number' && expr.arguments.length === 1) {
      return `((uint32_t)(${this.emitExpression(expr.arguments[0])}))`;
    }

    // strlen(s) -> strlen(s)
    if (calleeText === 'strlen' && expr.arguments.length === 1) {
      return `strlen(${this.emitExpression(expr.arguments[0])})`;
    }

    // Math.floor, Math.max, Math.min
    if (calleeText === 'Math.floor' && expr.arguments.length === 1) {
      const arg = this.emitExpression(expr.arguments[0]);
      return `((int32_t)(${arg}))`;
    }
    if (calleeText === 'Math.max' && expr.arguments.length === 2) {
      const a = this.emitExpression(expr.arguments[0]);
      const b = this.emitExpression(expr.arguments[1]);
      return `(((${a}) > (${b})) ? (${a}) : (${b}))`;
    }
    if (calleeText === 'Math.min' && expr.arguments.length === 2) {
      const a = this.emitExpression(expr.arguments[0]);
      const b = this.emitExpression(expr.arguments[1]);
      return `(((${a}) < (${b})) ? (${a}) : (${b}))`;
    }

    // Helper lambdas for memory load / store argument extraction
    const getLoadOffset = () => {
      return this.emitExpression(calleeText.startsWith('read_') ? expr.arguments[1] : expr.arguments[0]);
    };
    const getStoreArgs = () => {
      const isWriteFn = calleeText.startsWith('write_');
      const offset = this.emitExpression(isWriteFn ? expr.arguments[1] : expr.arguments[0]);
      const val = this.emitExpression(isWriteFn ? expr.arguments[2] : expr.arguments[1]);
      return { offset, val };
    };

    // Memory loads & stores
    if (calleeText === 'read_u8' || calleeText.endsWith('.getUint8')) {
      return `load_u8((const void *)(uintptr_t)(${getLoadOffset()}))`;
    }
    if (calleeText === 'write_u8' || calleeText.endsWith('.setUint8')) {
      const { offset, val } = getStoreArgs();
      return `store_u8((void *)(uintptr_t)(${offset}), ${val})`;
    }
    if (calleeText === 'read_u16' || calleeText.endsWith('.getUint16')) {
      return `load_u16((const void *)(uintptr_t)(${getLoadOffset()}))`;
    }
    if (calleeText === 'write_u16' || calleeText.endsWith('.setUint16')) {
      const { offset, val } = getStoreArgs();
      return `store_u16((void *)(uintptr_t)(${offset}), ${val})`;
    }
    if (calleeText === 'read_u32' || calleeText.endsWith('.getUint32')) {
      return `load_u32((const void *)(uintptr_t)(${getLoadOffset()}))`;
    }
    if (calleeText === 'write_u32' || calleeText.endsWith('.setUint32')) {
      const { offset, val } = getStoreArgs();
      return `store_u32((void *)(uintptr_t)(${offset}), ${val})`;
    }
    if (calleeText === 'read_i32' || calleeText.endsWith('.getInt32')) {
      return `load_i32((const void *)(uintptr_t)(${getLoadOffset()}))`;
    }
    if (calleeText === 'write_i32' || calleeText.endsWith('.setInt32')) {
      const { offset, val } = getStoreArgs();
      return `store_i32((void *)(uintptr_t)(${offset}), ${val})`;
    }
    if (calleeText === 'read_f64' || calleeText.endsWith('.getFloat64')) {
      return `load_f64((const void *)(uintptr_t)(${getLoadOffset()}))`;
    }
    if (calleeText === 'write_f64' || calleeText.endsWith('.setFloat64')) {
      const { offset, val } = getStoreArgs();
      return `store_f64((void *)(uintptr_t)(${offset}), ${val})`;
    }
    if (calleeText === 'read_u64' || calleeText.endsWith('.getBigUint64')) {
      return `load_u64((const void *)(uintptr_t)(${getLoadOffset()}))`;
    }
    if (calleeText === 'write_u64' || calleeText.endsWith('.setBigUint64')) {
      const { offset, val } = getStoreArgs();
      return `store_u64((void *)(uintptr_t)(${offset}), ${val})`;
    }
    if (calleeText === 'read_i64' || calleeText.endsWith('.getBigInt64')) {
      return `load_i64((const void *)(uintptr_t)(${getLoadOffset()}))`;
    }
    if (calleeText === 'write_i64' || calleeText.endsWith('.setBigInt64')) {
      const { offset, val } = getStoreArgs();
      return `store_i64((void *)(uintptr_t)(${offset}), ${val})`;
    }

    // memcpy, memset, memcmp
    if (calleeText === 'memcpy' && expr.arguments.length === 5) {
      const destOff = this.emitExpression(expr.arguments[1]);
      const srcOff = this.emitExpression(expr.arguments[3]);
      const n = this.emitExpression(expr.arguments[4]);
      return `webdb_memcpy((void *)(uintptr_t)(${destOff}), (const void *)(uintptr_t)(${srcOff}), ${n})`;
    }
    if (calleeText === 'memset' && expr.arguments.length === 4) {
      const destOff = this.emitExpression(expr.arguments[1]);
      const c = this.emitExpression(expr.arguments[2]);
      const n = this.emitExpression(expr.arguments[3]);
      return `webdb_memset((void *)(uintptr_t)(${destOff}), ${c}, ${n})`;
    }
    if (calleeText === 'memcmp' && expr.arguments.length === 5) {
      const s1Off = this.emitExpression(expr.arguments[1]);
      const s2Off = this.emitExpression(expr.arguments[3]);
      const n = this.emitExpression(expr.arguments[4]);
      return `webdb_memcmp((const void *)(uintptr_t)(${s1Off}), (const void *)(uintptr_t)(${s2Off}), ${n})`;
    }

    // Bit manipulation
    if (calleeText === 'get_bit') {
      if (expr.arguments.length === 3) {
        const ptr = this.emitExpression(expr.arguments[1]);
        const bit = this.emitExpression(expr.arguments[2]);
        return `get_bit((const uint8_t *)(uintptr_t)(${ptr}), ${bit})`;
      }
      const mask = this.emitExpression(expr.arguments[0]);
      const bit = this.emitExpression(expr.arguments[1]);
      return `get_bit((const uint8_t *)(uintptr_t)(${mask}), ${bit})`;
    }
    if (calleeText === 'set_bit') {
      if (expr.arguments.length === 3) {
        const ptr = this.emitExpression(expr.arguments[1]);
        const bit = this.emitExpression(expr.arguments[2]);
        return `set_bit((uint8_t *)(uintptr_t)(${ptr}), ${bit})`;
      }
      const mask = this.emitExpression(expr.arguments[0]);
      const bit = this.emitExpression(expr.arguments[1]);
      return `set_bit((uint8_t *)(uintptr_t)(${mask}), ${bit})`;
    }
    if (calleeText === 'clear_bit') {
      if (expr.arguments.length === 3) {
        const ptr = this.emitExpression(expr.arguments[1]);
        const bit = this.emitExpression(expr.arguments[2]);
        return `clear_bit((uint8_t *)(uintptr_t)(${ptr}), ${bit})`;
      }
      const mask = this.emitExpression(expr.arguments[0]);
      const bit = this.emitExpression(expr.arguments[1]);
      return `clear_bit((uint8_t *)(uintptr_t)(${mask}), ${bit})`;
    }

    // Default function call: filter out 'view' if stripping DataView
    const args: string[] = [];
    for (const arg of expr.arguments) {
      const argText = arg.getText();
      if (this.options.stripDataView && (argText === 'view' || argText === 'this.pool.view' || argText === 'scratch_view')) {
        continue;
      }
      args.push(this.emitExpression(arg));
    }

    const fnName = this.emitExpression(expr.expression);
    return `${fnName}(${args.join(', ')})`;
  }

  private emitPropertyAccess(expr: ts.PropertyAccessExpression): string {
    const objText = expr.expression.getText();
    const propText = expr.name.text;

    // Handle length on arrays or buffers
    if (propText === 'length') {
      return `${objText}_len`;
    }
    if (propText === 'byteLength') {
      if (objText === 'view' || objText === 'scratch_view') {
        return '4096';
      }
      return `${objText}_len`;
    }
    if (propText === 'buffer') {
      return objText;
    }

    return `${objText}.${propText}`;
  }
}
