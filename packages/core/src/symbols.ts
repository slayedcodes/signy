import ts from 'typescript';

/** One declaration the gate can tie changes to: `Name` at top level, or `Class.member`. */
export interface SourceSymbol {
  name: string;
  /** Part of the module's public interface. */
  exported: boolean;
  /** The public signature, whitespace-normalized; only for exported API. */
  signature?: string;
  /**
   * The declaration's source text plus the imports it uses. Any change to it is a change
   * to the symbol, including pointing one of its imports at a different module.
   */
  text: string;
}

export interface ExtractedSymbols {
  symbols: SourceSymbol[];
  /**
   * Code that belongs to no declaration: top-level statements, bare imports, and imports
   * no declaration uses (importing a module runs it). The gate can't tie it to a symbol,
   * so changing it is never silently in scope.
   */
  topLevel: string;
  /** The file has syntax errors, so its symbols can't be trusted. */
  parseError: boolean;
}

/** A symbol while the file is being read: its signature is kept even when not exported. */
interface Draft {
  name: string;
  exported: boolean;
  signature: string;
  text: string;
  nodes: ts.Node[];
}

/** One name an import statement binds, rendered on its own. */
interface ImportBinding {
  local: string;
  text: string;
}

/**
 * Reads the symbols of one TypeScript or JavaScript file, without type checking.
 * Declarations sharing a name (overloads, get/set pairs) become one symbol.
 */
export function extractSymbols(path: string, text: string): ExtractedSymbols {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const drafts = new Map<string, Draft>();
  const collect = (draft: Draft) => {
    const existing = drafts.get(draft.name);
    if (!existing) {
      drafts.set(draft.name, draft);
      return;
    }
    existing.text += `\n${draft.text}`;
    existing.signature += `;${draft.signature}`;
    existing.exported ||= draft.exported;
    existing.nodes.push(...draft.nodes);
  };

  const imports: ImportBinding[] = [];
  const topLevelStatements: ts.Statement[] = [];
  const aliases: Array<{ draft: Draft; target: string }> = [];

  for (const statement of source.statements) {
    const exported = hasModifier(statement, ts.SyntaxKind.ExportKeyword);
    const asDefault = hasModifier(statement, ts.SyntaxKind.DefaultKeyword) ? 'default ' : '';
    if (ts.isImportDeclaration(statement) || ts.isImportEqualsDeclaration(statement)) {
      const bindings = importBindings(statement, source);
      if (bindings.length === 0) topLevelStatements.push(statement);
      imports.push(...bindings);
    } else if (ts.isFunctionDeclaration(statement)) {
      const name = statement.name?.text ?? 'default';
      const signature = (statement.name ? asDefault : '') + functionSignature(name, statement, source);
      collect(draft(name, exported, normalizeSignature(signature), statement.getText(source), statement));
    } else if (ts.isClassDeclaration(statement)) {
      readClass(statement.name?.text ?? 'default', statement, exported, statement.name ? asDefault : '', source).forEach(
        collect,
      );
    } else if (ts.isVariableStatement(statement)) {
      readVariables(statement, exported, source).forEach(collect);
    } else if (
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isEnumDeclaration(statement) ||
      ts.isModuleDeclaration(statement)
    ) {
      const declaration = statement.getText(source);
      collect(draft(statement.name.getText(source), exported, wholeSignature(declaration), declaration, statement));
    } else if (ts.isExportAssignment(statement)) {
      const name = statement.isExportEquals ? 'export=' : 'default';
      const expression = statement.expression.getText(source);
      const exportDraft = draft(name, true, normalizeSignature(`${name}=${expression}`), statement.getText(source), statement);
      if (ts.isIdentifier(statement.expression)) aliases.push({ draft: exportDraft, target: statement.expression.text });
      collect(exportDraft);
    } else if (ts.isExportDeclaration(statement)) {
      for (const { draft: exportDraft, target } of readExportDeclaration(statement, source)) {
        if (target !== undefined) aliases.push({ draft: exportDraft, target });
        collect(exportDraft);
      }
    } else {
      topLevelStatements.push(statement);
    }
  }

  // A local alias (`export { foo as bar }`, `export default foo`) exposes foo's signature.
  for (const { draft: alias, target } of aliases) {
    const local = drafts.get(target);
    if (local && local !== alias) alias.signature = normalizeSignature(`${alias.name}=${local.signature}`);
  }

  const usedImports = new Set<ImportBinding>();
  const importsUsedBy = (nodes: ts.Node[]) => {
    const names = referencedNames(nodes);
    const used = imports.filter((binding) => names.has(binding.local));
    used.forEach((binding) => usedImports.add(binding));
    return used.map((binding) => binding.text);
  };
  const symbols = [...drafts.values()].map<SourceSymbol>((d) => ({
    name: d.name,
    exported: d.exported,
    ...(d.exported ? { signature: d.signature } : {}),
    text: [d.text, ...importsUsedBy(d.nodes)].join('\n'),
  }));
  const topLevel = [
    ...topLevelStatements.map((s) => s.getText(source)),
    ...importsUsedBy(topLevelStatements),
    ...imports.filter((binding) => !usedImports.has(binding)).map((binding) => binding.text),
  ];
  // TypeScript's syntax errors aren't on the public SourceFile type; the version is pinned for this.
  const parseError = (source as unknown as { parseDiagnostics: unknown[] }).parseDiagnostics.length > 0;
  // An import can be both used by top-level code and listed once more as unused by symbols.
  return { symbols, topLevel: [...new Set(topLevel)].join('\n'), parseError };
}

function draft(name: string, exported: boolean, signature: string, text: string, node: ts.Node): Draft {
  return { name, exported, signature, text, nodes: [node] };
}

/** Each name an import binds, e.g. `import { a as b } from './x'` → `import { a as b } from './x'`. */
function importBindings(statement: ts.ImportDeclaration | ts.ImportEqualsDeclaration, source: ts.SourceFile): ImportBinding[] {
  if (ts.isImportEqualsDeclaration(statement)) {
    const local = statement.name.text;
    return [{ local, text: `import ${local} = ${statement.moduleReference.getText(source)}` }];
  }
  const clause = statement.importClause;
  if (!clause) return [];
  const from = statement.moduleSpecifier.getText(source);
  const bindings: ImportBinding[] = [];
  if (clause.name) bindings.push({ local: clause.name.text, text: `import ${clause.name.text} from ${from}` });
  const named = clause.namedBindings;
  if (named && ts.isNamespaceImport(named)) {
    bindings.push({ local: named.name.text, text: `import * as ${named.name.text} from ${from}` });
  } else if (named) {
    for (const element of named.elements) {
      const imported = element.propertyName ? `${element.propertyName.getText(source)} as ${element.name.text}` : element.name.text;
      bindings.push({ local: element.name.text, text: `import { ${imported} } from ${from}` });
    }
  }
  return bindings;
}

/** Every identifier the nodes mention. Over-counting is safe: it only ties more imports to a symbol. */
function referencedNames(nodes: ts.Node[]): Set<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node)) names.add(node.text);
    ts.forEachChild(node, visit);
  };
  nodes.forEach(visit);
  return names;
}

function readVariables(statement: ts.VariableStatement, exported: boolean, source: ts.SourceFile): Draft[] {
  const declarations = statement.declarationList.declarations;
  const modifiers = (ts.getModifiers(statement) ?? []).map((m) => `${m.getText(source)} `).join('');
  const keyword = declarationKeyword(statement.declarationList);
  return declarations.flatMap((declaration) => {
    // A single declaration owns the whole statement; in `let a = 1, b = 2` each owns its part,
    // with the keyword, so that `let` to `const` still changes it.
    const text =
      declarations.length === 1 ? statement.getText(source) : `${modifiers}${keyword} ${declaration.getText(source)};`;
    return bindingNames(declaration.name).map((name) =>
      draft(name, exported, variableSignature(name, declaration, source), text, declaration),
    );
  });
}

function declarationKeyword(list: ts.VariableDeclarationList): string {
  if (list.flags & ts.NodeFlags.Const) return 'const';
  if (list.flags & ts.NodeFlags.Let) return 'let';
  if (list.flags & ts.NodeFlags.AwaitUsing) return 'await using';
  if (list.flags & ts.NodeFlags.Using) return 'using';
  return 'var';
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((element) => (ts.isOmittedExpression(element) ? [] : bindingNames(element.name)));
}

function variableSignature(name: string, declaration: ts.VariableDeclaration, source: ts.SourceFile): string {
  const value = declaration.initializer;
  if (!declaration.type && value && (ts.isArrowFunction(value) || ts.isFunctionExpression(value))) {
    return functionSignature(name, value, source);
  }
  // Without a type checker, an unannotated variable's type is its initializer.
  if (declaration.type) return normalizeSignature(`${name}:${declaration.type.getText(source)}`);
  return normalizeSignature(value ? `${name}=${value.getText(source)}` : name);
}

/** For declarations that are all interface (types, interfaces, enums): the text minus export keywords. */
function wholeSignature(text: string): string {
  return normalizeSignature(text.replace(/^(?:(?:export|declare|default)\s+)+/, ''));
}

/**
 * `export { a as b } from './x'`, `export * from './y'`, `export { local as alias }`.
 * `target` names the local declaration a local alias points to.
 */
function readExportDeclaration(
  statement: ts.ExportDeclaration,
  source: ts.SourceFile,
): Array<{ draft: Draft; target?: string }> {
  const text = statement.getText(source);
  const from = statement.moduleSpecifier ? `from ${statement.moduleSpecifier.getText(source)}` : '';
  const clause = statement.exportClause;
  if (!clause) return [{ draft: draft('*', true, normalizeSignature(`*=${from}`), text, statement) }];
  if (ts.isNamespaceExport(clause)) {
    const name = clause.name.text;
    return [{ draft: draft(name, true, normalizeSignature(`${name}=${from}#*`), text, statement) }];
  }
  return clause.elements.map((specifier) => {
    const name = specifier.name.text;
    const target = specifier.propertyName?.getText(source) ?? name;
    const signature = from ? `${name}=${from}#${target}` : `${name}=${target}`;
    return { draft: draft(name, true, normalizeSignature(signature), text, statement), ...(from ? {} : { target }) };
  });
}

function readClass(
  name: string,
  node: ts.ClassLikeDeclaration,
  exported: boolean,
  asDefault: string,
  source: ts.SourceFile,
): Draft[] {
  const typeParameters = typeParameterText(node, source);
  const heritage = (node.heritageClauses ?? []).map((h) => ` ${h.getText(source)}`).join('');
  // The class's own text is its header: changes inside members belong to the members.
  const header = source.text.slice(node.getStart(source), node.members.pos).trim();
  const headerNodes = [...(ts.getModifiers(node) ?? []), ...(ts.getDecorators(node) ?? []), ...(node.heritageClauses ?? [])];
  const drafts: Draft[] = [
    {
      name,
      exported,
      signature: normalizeSignature(`${asDefault}class ${name}${typeParameters}${heritage}`),
      text: header,
      nodes: headerNodes,
    },
  ];

  for (const member of node.members) {
    const memberName = classMemberName(member, source);
    if (memberName === undefined) continue;
    const qualified = `${name}.${memberName}`;
    const isPublic =
      !(member.name && ts.isPrivateIdentifier(member.name)) &&
      !hasModifier(member, ts.SyntaxKind.PrivateKeyword) &&
      !hasModifier(member, ts.SyntaxKind.ProtectedKeyword);
    const isStatic = hasModifier(member, ts.SyntaxKind.StaticKeyword) ? 'static ' : '';
    const signature = isStatic + memberSignature(qualified, member, source);
    drafts.push(draft(qualified, exported && isPublic, signature, member.getText(source), member));
  }
  return drafts;
}

function classMemberName(member: ts.ClassElement, source: ts.SourceFile): string | undefined {
  if (ts.isConstructorDeclaration(member)) return 'constructor';
  if (ts.isClassStaticBlockDeclaration(member)) return 'static';
  if (ts.isIndexSignatureDeclaration(member)) return '[index]';
  return member.name?.getText(source);
}

function memberSignature(qualified: string, member: ts.ClassElement, source: ts.SourceFile): string {
  if (ts.isMethodDeclaration(member) || ts.isConstructorDeclaration(member)) {
    return functionSignature(qualified, member, source);
  }
  if (ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) {
    return normalizeSignature(`${ts.isGetAccessor(member) ? 'get' : 'set'} ${functionSignature(qualified, member, source)}`);
  }
  if (ts.isPropertyDeclaration(member)) {
    // Without a type checker, an unannotated property's type is its initializer.
    const type = member.type ? `:${member.type.getText(source)}` : member.initializer ? `=${member.initializer.getText(source)}` : '';
    return normalizeSignature(`${qualified}${member.questionToken ? '?' : ''}${type}`);
  }
  return normalizeSignature(member.getText(source));
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === kind);
}

function typeParameterText(node: { typeParameters?: ts.NodeArray<ts.TypeParameterDeclaration> }, source: ts.SourceFile): string {
  return node.typeParameters ? `<${node.typeParameters.map((t) => t.getText(source)).join(',')}>` : '';
}

/** `name<T>(params): Return`, from the source text of each part. */
function functionSignature(name: string, fn: ts.SignatureDeclarationBase, source: ts.SourceFile): string {
  const parameters = fn.parameters.map((p) => p.getText(source)).join(',');
  const returns = fn.type ? `:${fn.type.getText(source)}` : '';
  return normalizeSignature(`${name}${typeParameterText(fn, source)}(${parameters})${returns}`);
}

/** Drops whitespace except where it separates two words, so formatting never reads as a change. */
export function normalizeSignature(signature: string): string {
  return signature.replace(/\s+/g, ' ').replace(/ (?!\w)|(?<!\w) /g, '');
}
