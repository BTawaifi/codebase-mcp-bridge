import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { RepoService } from "./repo.js";

type SymbolDefinition = {
  name: string;
  kind: "function" | "class" | "interface" | "method" | "other";
  filePath: string;
  startLine: number;
  endLine: number;
  signature: string;
  docstring?: string;
  references: string[]; // List of other symbol names referenced inside this definition
};

type IndexManifestEntry = {
  mtimeMs: number;
  size: number;
  contentHash: string;
  policyVersion: number;
  blocked?: boolean;
};

type IndexManifest = Record<string, IndexManifestEntry>;

const INDEX_IO_CONCURRENCY = 12;
const INDEX_POLICY_VERSION = 2;

const KEYWORDS = new Set([
  "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete",
  "do", "else", "export", "extends", "finally", "for", "function", "if", "import", "in",
  "instanceof", "new", "return", "super", "switch", "this", "throw", "try", "typeof", "var",
  "void", "while", "with", "yield", "let", "static", "enum", "await", "async", "public",
  "private", "protected", "package", "implements", "interface", "type", "of", "from",
  "def", "self", "import", "as", "from", "and", "or", "not", "is", "in", "lambda",
  "pass", "nonlocal", "global", "assert", "del", "except", "raise", "elif", "None", "True", "False",
  "func", "struct", "interface", "type", "var", "const", "package", "defer", "go", "chan", "select", "range", "map", "nil"
]);

// Hoisted Regular Expressions for Performance
const COMMENT_LINE_REGEX = /\/\/.*$/;
const COMMENT_BLOCK_REGEX = /\/\*[\s\S]*?\*\//g;
const STRING_LITERAL_REGEX = /(["'`])(?:\\.|[^\\])*?\1/g;
const WORD_REGEX = /\b[A-Za-z_$][\w$]*/g;

// parseBracketSymbols Regexes
const CLASS_INTERFACE_REGEX = /\b(?:class|interface|struct|trait|impl)\s+([A-Za-z_$][\w$]*)/;
const GO_TYPE_REGEX = /^\s*type\s+([A-Za-z_$][\w$]*)\s+(struct|interface)\b/;
const FUNCTION_REGEX = /\b(?:async\s+)?(?:function|func|fn|fun)\s+([A-Za-z_$][\w$]*)/;
const METHOD_REGEX = /\bfunc\s*\([^)]*\)\s*([A-Za-z_$][\w$]*)\s*\(/;
const GO_PACKAGE_REGEX = /^\s*package\s+([A-Za-z_$][\w$]*)/;
const GO_INTERFACE_METHOD_REGEX = /^\s*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?:[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)?/;
const GO_SINGLE_IMPORT_REGEX = /^\s*import\s+(?:[A-Za-z_$][\w$]*\s+|_\s+|\.\s+)?["`]([^"`]+)["`]/;
const GO_BLOCK_IMPORT_REGEX = /^\s*(?:[A-Za-z_$][\w$]*\s+|_\s+|\.\s+)?["`]([^"`]+)["`]/;
const ARROW_FUNCTION_REGEX = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/;
const CLASS_MEMBER_METHOD_REGEX = /^\s*(?:async\s+|get\s+|set\s+|public\s+|private\s+|protected\s+|static\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[^{]+)?\s*\{/;

// parseIndentationSymbols Regexes
const INDENT_REGEX = /^\s*/;
const PYTHON_CLASS_REGEX = /^class\s+([A-Za-z_]\w*)/;
const PYTHON_DEF_REGEX = /^def\s+([A-Za-z_]\w*)/;

function stripCommentsAndStrings(line: string): string {
  let s = line.replace(COMMENT_LINE_REGEX, "");
  s = s.replace(COMMENT_BLOCK_REGEX, "");
  s = s.replace(STRING_LITERAL_REGEX, "");
  return s;
}

function extractWords(text: string, excludeName: string): string[] {
  const words = new Set<string>();
  for (const match of text.matchAll(WORD_REGEX)) {
    const word = match[0];
    if (!KEYWORDS.has(word) && word !== excludeName && word.length >= 2) {
      words.add(word);
    }
  }
  return [...words];
}

function extractGoReferences(text: string, excludeName: string): string[] {
  const words = new Set(extractWords(text, excludeName));
  for (const match of text.matchAll(/\.([A-Za-z_$][\w$]*)\b/g)) {
    const name = match[1];
    if (!KEYWORDS.has(name) && name !== excludeName && name.length >= 2) {
      words.add(name);
    }
  }
  return [...words];
}

function parseBracketSymbols(filePath: string, text: string): SymbolDefinition[] {
  const lines = text.split(/\r?\n/);
  const symbols: SymbolDefinition[] = [];
  const isGo = path.extname(filePath).toLowerCase() === ".go";
  if (isGo) return parseGoSymbols(filePath, text);

  symbols.push({
    name: path.basename(filePath),
    kind: "other",
    filePath,
    startLine: 1,
    endLine: lines.length,
    signature: `module ${filePath}`,
    references: extractWords(text, "")
  });

  const stack: { symbol: SymbolDefinition; startBraceLevel: number }[] = [];
  let currentBraceLevel = 0;
  let recentComments: string[] = [];
  let pendingSymbol: SymbolDefinition | null = null;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();

    if (trimmed.startsWith("//")) {
      recentComments.push(trimmed.slice(2).trim());
      continue;
    } else if (trimmed.startsWith("/*") || trimmed.startsWith("*")) {
      const c = trimmed.replace(/^\/\*+\s*/, "").replace(/\*+\/\s*$/, "").replace(/^\*\s*/, "").trim();
      if (c) recentComments.push(c);
      continue;
    }

    const stripped = stripCommentsAndStrings(rawLine);

    let braceDiff = 0;
    for (const char of stripped) {
      if (char === '{') braceDiff++;
      if (char === '}') braceDiff--;
    }

    if (pendingSymbol) {
      pendingSymbol.signature += `\n${trimmed}`;
      if (stripped.includes("{")) {
        stack.push({ symbol: pendingSymbol, startBraceLevel: currentBraceLevel });
        pendingSymbol = null;
      }
    } else
    if (trimmed.length > 0) {
      let match: RegExpMatchArray | null = null;
      let name = "";
      let kind: SymbolDefinition["kind"] = "other";

      if ((match = stripped.match(CLASS_INTERFACE_REGEX))) {
        name = match[1];
        kind = stripped.includes("interface") ? "interface" : (stripped.includes("struct") ? "class" : "class");
      } else if ((match = stripped.match(FUNCTION_REGEX))) {
        name = match[1];
        kind = "function";
      } else if ((match = stripped.match(ARROW_FUNCTION_REGEX))) {
        name = match[1];
        kind = "function";
      } else if (stack.length > 0 && stack[stack.length - 1].symbol.kind === "class") {
        if ((match = stripped.match(CLASS_MEMBER_METHOD_REGEX))) {
          name = match[1];
          kind = "method";
        }
      }

      if (name && kind !== "other" && (kind === "method" || !KEYWORDS.has(name))) {
        const docstring = recentComments.length > 0 ? recentComments.join("\n") : undefined;
        const newSym: SymbolDefinition = {
          name,
          kind,
          filePath,
          startLine: i + 1,
          endLine: i + 1,
          signature: trimmed,
          docstring,
          references: []
        };
        if (stripped.includes("{")) {
          stack.push({ symbol: newSym, startBraceLevel: currentBraceLevel });
        } else {
          pendingSymbol = newSym;
        }
        recentComments = [];
      }
    }

    currentBraceLevel += braceDiff;

    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (currentBraceLevel <= top.startBraceLevel) {
        const popped = stack.pop()!;
        popped.symbol.endLine = i + 1;
        
        const bodyLines = lines.slice(popped.symbol.startLine - 1, popped.symbol.endLine);
        const bodyText = bodyLines.join("\n");
        popped.symbol.references = extractWords(bodyText, popped.symbol.name);
        
        symbols.push(popped.symbol);
      } else {
        break;
      }
    }

    if (trimmed.length > 0 && !trimmed.startsWith("//") && !trimmed.startsWith("/*") && !trimmed.startsWith("*") && !trimmed.startsWith("*/")) {
      recentComments = [];
    }
  }

  while (stack.length > 0) {
    const popped = stack.pop()!;
    popped.symbol.endLine = lines.length;
    const bodyLines = lines.slice(popped.symbol.startLine - 1, popped.symbol.endLine);
    const bodyText = bodyLines.join("\n");
    popped.symbol.references = extractWords(bodyText, popped.symbol.name);
    symbols.push(popped.symbol);
  }

  return symbols;
}

function parseGoSymbols(filePath: string, text: string): SymbolDefinition[] {
  const lines = text.split(/\r?\n/);
  const symbols: SymbolDefinition[] = [];
  const goMetadataReferences: string[] = [];
  let inGoImportBlock = false;

  for (const line of lines) {
    const stripped = stripCommentsAndStrings(line);
    const packageMatch = stripped.match(GO_PACKAGE_REGEX);
    if (packageMatch) goMetadataReferences.push(packageMatch[1]);

    if (/^\s*import\s*\(\s*$/.test(stripped)) {
      inGoImportBlock = true;
      continue;
    }
    if (inGoImportBlock && /^\s*\)\s*$/.test(stripped)) {
      inGoImportBlock = false;
      continue;
    }
    const importMatch = inGoImportBlock
      ? stripped.match(GO_BLOCK_IMPORT_REGEX)
      : stripped.match(GO_SINGLE_IMPORT_REGEX);
    if (importMatch) goMetadataReferences.push(...importMatch[1].split(/[\/.-]+/).filter(Boolean));
  }

  symbols.push({
    name: path.basename(filePath),
    kind: "other",
    filePath,
    startLine: 1,
    endLine: lines.length,
    signature: `module ${filePath}`,
    references: [...new Set([...extractWords(text, ""), ...goMetadataReferences])]
  });

  let recentComments: string[] = [];
  let activeInterface: { name: string; startBraceDepth: number } | null = null;
  let braceDepth = 0;

  function lineBraceDiff(line: string): number {
    let diff = 0;
    for (const char of stripCommentsAndStrings(line)) {
      if (char === "{") diff++;
      if (char === "}") diff--;
    }
    return diff;
  }

  function collectBlock(startIndex: number): { endLine: number; bodyText: string } {
    let depth = 0;
    let sawOpen = false;
    for (let j = startIndex; j < lines.length; j++) {
      const stripped = stripCommentsAndStrings(lines[j]);
      for (const char of stripped) {
        if (char === "{") {
          depth++;
          sawOpen = true;
        } else if (char === "}") {
          depth--;
        }
      }
      if (sawOpen && depth <= 0) {
        return { endLine: j + 1, bodyText: lines.slice(startIndex, j + 1).join("\n") };
      }
    }
    return { endLine: startIndex + 1, bodyText: lines[startIndex] ?? "" };
  }

  function pushSymbol(name: string, kind: SymbolDefinition["kind"], index: number, signature: string, endLine: number, bodyText: string): void {
    symbols.push({
      name,
      kind,
      filePath,
      startLine: index + 1,
      endLine,
      signature,
      docstring: recentComments.length > 0 ? recentComments.join("\n") : undefined,
      references: extractGoReferences(bodyText, name),
    });
    recentComments = [];
  }

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();

    if (trimmed.startsWith("//")) {
      recentComments.push(trimmed.slice(2).trim());
      continue;
    } else if (trimmed.startsWith("/*") || trimmed.startsWith("*")) {
      const c = trimmed.replace(/^\/\*+\s*/, "").replace(/\*+\/\s*$/, "").replace(/^\*\s*/, "").trim();
      if (c) recentComments.push(c);
      continue;
    }

    const stripped = stripCommentsAndStrings(rawLine);

    let match: RegExpMatchArray | null = null;

    if (activeInterface && braceDepth === activeInterface.startBraceDepth + 1 && (match = stripped.match(GO_INTERFACE_METHOD_REGEX))) {
      const name = match[1];
      if (!KEYWORDS.has(name)) {
        pushSymbol(name, "method", i, trimmed, i + 1, rawLine);
      }
    }

    if ((match = stripped.match(GO_TYPE_REGEX))) {
      const name = match[1];
      const kind: SymbolDefinition["kind"] = match[2] === "interface" ? "interface" : "class";
      const block = collectBlock(i);
      pushSymbol(name, kind, i, trimmed, block.endLine, block.bodyText);
      if (kind === "interface" && stripped.includes("{")) {
        activeInterface = { name, startBraceDepth: braceDepth };
      }
    } else if ((match = stripped.match(METHOD_REGEX))) {
      const block = collectBlock(i);
      pushSymbol(match[1], "method", i, trimmed, block.endLine, block.bodyText);
    } else if ((match = stripped.match(FUNCTION_REGEX))) {
      const name = match[1];
      if (!KEYWORDS.has(name)) {
        const block = collectBlock(i);
        pushSymbol(name, "function", i, trimmed, block.endLine, block.bodyText);
      }
    }

    braceDepth += lineBraceDiff(rawLine);
    if (activeInterface && braceDepth <= activeInterface.startBraceDepth) {
      activeInterface = null;
    }

    if (trimmed.length > 0 && !trimmed.startsWith("//") && !trimmed.startsWith("/*") && !trimmed.startsWith("*") && !trimmed.startsWith("*/")) {
      recentComments = [];
    }
  }

  return symbols;
}

function parseIndentationSymbols(filePath: string, text: string): SymbolDefinition[] {
  const lines = text.split(/\r?\n/);
  const symbols: SymbolDefinition[] = [];
  
  symbols.push({
    name: path.basename(filePath),
    kind: "other",
    filePath,
    startLine: 1,
    endLine: lines.length,
    signature: `module ${filePath}`,
    references: extractWords(text, "")
  });

  const stack: { symbol: SymbolDefinition; indent: number }[] = [];
  let recentComments: string[] = [];
  let inTripleQuoteDocstring = false;
  let docstringBuffer: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();

    // Handle Python single-line triple quote docstrings
    if (trimmed.startsWith('"""') && trimmed.endsWith('"""') && trimmed.length >= 6) {
      recentComments.push(trimmed.slice(3, -3).trim());
      continue;
    }
    if (trimmed.startsWith("'''") && trimmed.endsWith("'''") && trimmed.length >= 6) {
      recentComments.push(trimmed.slice(3, -3).trim());
      continue;
    }

    if (trimmed.startsWith('"""') || trimmed.startsWith("'''")) {
      if (inTripleQuoteDocstring) {
        inTripleQuoteDocstring = false;
        recentComments.push(docstringBuffer.join("\n"));
        docstringBuffer = [];
      } else {
        inTripleQuoteDocstring = true;
        const content = trimmed.replace(/^["']{3}/, "").replace(/["']{3}$/, "").trim();
        if (content) docstringBuffer.push(content);
      }
      continue;
    }

    if (inTripleQuoteDocstring) {
      docstringBuffer.push(trimmed);
      continue;
    }

    if (trimmed.startsWith("#")) {
      recentComments.push(trimmed.slice(1).trim());
      continue;
    }

    if (trimmed.length === 0) continue;

    const indent = rawLine.match(INDENT_REGEX)?.[0].length ?? 0;

    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (indent <= top.indent) {
        const popped = stack.pop()!;
        popped.symbol.endLine = i;
        
        const bodyLines = lines.slice(popped.symbol.startLine - 1, popped.symbol.endLine);
        const bodyText = bodyLines.join("\n");
        popped.symbol.references = extractWords(bodyText, popped.symbol.name);
        
        symbols.push(popped.symbol);
      } else {
        break;
      }
    }

    let match: RegExpMatchArray | null = null;
    let name = "";
    let kind: SymbolDefinition["kind"] = "other";

    if ((match = trimmed.match(PYTHON_CLASS_REGEX))) {
      name = match[1];
      kind = "class";
    } else if ((match = trimmed.match(PYTHON_DEF_REGEX))) {
      name = match[1];
      kind = stack.length > 0 && stack[stack.length - 1].symbol.kind === "class" ? "method" : "function";
    }

    if (name && kind !== "other") {
      const docstring = recentComments.length > 0 ? recentComments.join("\n") : undefined;
      const newSym: SymbolDefinition = {
        name,
        kind,
        filePath,
        startLine: i + 1,
        endLine: i + 1,
        signature: trimmed,
        docstring,
        references: []
      };
      stack.push({ symbol: newSym, indent });
      recentComments = [];
    } else {
      recentComments = [];
    }
  }

  while (stack.length > 0) {
    const popped = stack.pop()!;
    popped.symbol.endLine = lines.length;
    const bodyLines = lines.slice(popped.symbol.startLine - 1, popped.symbol.endLine);
    const bodyText = bodyLines.join("\n");
    popped.symbol.references = extractWords(bodyText, popped.symbol.name);
    symbols.push(popped.symbol);
  }

  return symbols;
}

export function parseFileSymbols(filePath: string, text: string): SymbolDefinition[] {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".py") {
    return parseIndentationSymbols(filePath, text);
  } else if ([".ts", ".tsx", ".js", ".jsx", ".java", ".cs", ".cpp", ".c", ".h", ".go", ".rs", ".kt", ".swift", ".php"].includes(ext)) {
    return parseBracketSymbols(filePath, text);
  }
  return [];
}

export class IndexerService {
  private cachedSymbols: SymbolDefinition[] | undefined;
  private freshUntilMs = 0;
  private buildPromise: Promise<SymbolDefinition[]> | undefined;
  private staleGeneration = 0;

  constructor(
    private readonly repoRoot: string,
    private readonly repo: RepoService
  ) {}

  markStale(): void {
    this.staleGeneration += 1;
    this.freshUntilMs = 0;
  }

  async ensureFreshIndex(maxAgeMs = 1_000): Promise<SymbolDefinition[]> {
    if (this.cachedSymbols && Date.now() < this.freshUntilMs) return this.cachedSymbols;
    if (this.buildPromise) return this.buildPromise;
    const generation = this.staleGeneration;
    this.buildPromise = this.buildIndex().finally(() => { this.buildPromise = undefined; });
    const symbols = await this.buildPromise;
    this.freshUntilMs = generation === this.staleGeneration ? Date.now() + Math.max(0, maxAgeMs) : 0;
    return symbols;
  }

  async buildIndex(): Promise<SymbolDefinition[]> {
    const bridgeDir = path.join(this.repoRoot, ".ai-bridge");
    const symbolsPath = path.join(bridgeDir, "symbols.json");
    const manifestPath = path.join(bridgeDir, "symbol-manifest.json");
    const indexableFiles = await this.repo.indexableFiles();

    const previousSymbols = await readJsonFile<SymbolDefinition[]>(symbolsPath, []);
    const previousManifest = await readJsonFile<IndexManifest>(manifestPath, {});
    const symbolsByFile = groupSymbolsByFile(previousSymbols);
    const nextManifest: IndexManifest = {};

    const fileResults = await mapWithConcurrency(indexableFiles, INDEX_IO_CONCURRENCY, async (rel) => {
      try {
        const abs = path.join(this.repoRoot, rel);
        const stat = await fs.stat(abs);
        const cached = previousManifest[rel];
        if (
          cached &&
          cached.policyVersion === INDEX_POLICY_VERSION &&
          cached.mtimeMs === stat.mtimeMs &&
          cached.size === stat.size
        ) {
          nextManifest[rel] = cached;
          if (cached.blocked) return [];
          if (symbolsByFile.has(rel)) return symbolsByFile.get(rel) ?? [];
        }

        const text = await this.repo.readIndexableFile(rel);
        if (text === undefined) {
          nextManifest[rel] = {
            mtimeMs: stat.mtimeMs,
            size: stat.size,
            contentHash: "secret-blocked",
            policyVersion: INDEX_POLICY_VERSION,
            blocked: true,
          };
          return [];
        }

        const contentHash = crypto.createHash("sha256").update(text).digest("hex");
        nextManifest[rel] = {
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          contentHash,
          policyVersion: INDEX_POLICY_VERSION,
        };

        if (
          cached?.policyVersion === INDEX_POLICY_VERSION &&
          !cached.blocked &&
          cached.contentHash === contentHash &&
          symbolsByFile.has(rel)
        ) {
          return symbolsByFile.get(rel) ?? [];
        }

        try {
          return parseFileSymbols(rel, text);
        } catch {
          return [];
        }
      } catch {
        return [];
      }
    });

    const allSymbols = fileResults.flat();
    const symbolsChanged = JSON.stringify(allSymbols) !== JSON.stringify(previousSymbols);
    const manifestChanged = JSON.stringify(nextManifest) !== JSON.stringify(previousManifest);

    await fs.mkdir(bridgeDir, { recursive: true });
    await Promise.all([
      ...(symbolsChanged ? [fs.writeFile(symbolsPath, JSON.stringify(allSymbols, null, 2), "utf8")] : []),
      ...(manifestChanged ? [fs.writeFile(manifestPath, JSON.stringify(nextManifest, null, 2), "utf8")] : []),
      fs.rm(path.join(bridgeDir, "index.json"), { force: true }),
      fs.rm(path.join(bridgeDir, "index-manifest.json"), { force: true }),
    ]);

    this.cachedSymbols = allSymbols;
    return allSymbols;
  }

  async loadSymbols(): Promise<SymbolDefinition[]> {
    if (this.cachedSymbols) return this.cachedSymbols;
    const symbolsPath = path.join(this.repoRoot, ".ai-bridge", "symbols.json");
    try {
      const content = await fs.readFile(symbolsPath, "utf8");
      this.cachedSymbols = JSON.parse(content) as SymbolDefinition[];
      return this.cachedSymbols;
    } catch {
      await this.buildIndex();
      return this.cachedSymbols ?? [];
    }
  }

  async getCallers(symbolName: string): Promise<string> {
    const symbols = await this.loadSymbols();
    const needle = symbolName.toLowerCase();
    const allMatches = dedupeRelationshipSymbols(symbols.filter((symbol) =>
      symbol.kind !== "other" && symbol.references.some((reference) => reference.toLowerCase() === needle)
    ));
    const matches = allMatches.slice(0, 100).map(symbolSummary);
    return JSON.stringify({ symbolName, matches, truncated: allMatches.length > matches.length }, null, 2);
  }

  async getCallees(symbolName: string): Promise<string> {
    const symbols = await this.loadSymbols();
    const targets = symbols.filter((symbol) => symbol.kind !== "other" && symbol.name.toLowerCase() === symbolName.toLowerCase());
    const definitionsByName = new Map<string, SymbolDefinition[]>();
    for (const symbol of symbols) {
      if (symbol.kind === "other") continue;
      const key = symbol.name.toLowerCase();
      definitionsByName.set(key, [...(definitionsByName.get(key) ?? []), symbol]);
    }

    const matches: Array<Record<string, unknown>> = [];
    const seen = new Set<string>();
    let truncated = false;
    for (const target of targets) {
      for (const reference of target.references) {
        for (const definition of definitionsByName.get(reference.toLowerCase()) ?? []) {
          const key = `${definition.filePath}:${definition.startLine}:${definition.name}`;
          if (seen.has(key)) continue;
          seen.add(key);
          if (matches.length >= 100) { truncated = true; break; }
          matches.push(symbolSummary(definition));
        }
        if (truncated) break;
      }
      if (truncated) break;
    }
    return JSON.stringify({ symbolName, found: targets.length > 0, matches, truncated }, null, 2);
  }

  async getImpactRadius(symbolName: string, maxDepth = 2): Promise<string> {
    const symbols = await this.loadSymbols();
    const callersByName = new Map<string, SymbolDefinition[]>();
    for (const symbol of symbols) {
      if (symbol.kind === "other") continue;
      for (const reference of new Set(symbol.references.map((name) => name.toLowerCase()))) {
        const callers = callersByName.get(reference);
        if (callers) callers.push(symbol);
        else callersByName.set(reference, [symbol]);
      }
    }
    const visitedNames = new Set<string>();
    const seenMatches = new Set<string>();
    const matches: Array<Record<string, unknown>> = [];
    let frontier = [symbolName];
    let truncated = false;

    for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth += 1) {
      const next: string[] = [];
      for (const currentName of frontier) {
        const keyName = currentName.toLowerCase();
        if (visitedNames.has(keyName)) continue;
        visitedNames.add(keyName);
        const callers = callersByName.get(keyName) ?? [];
        for (const caller of callers) {
          const key = `${caller.filePath}:${caller.startLine}:${caller.name}`;
          if (!seenMatches.has(key)) {
            if (matches.length >= 200) { truncated = true; break; }
            seenMatches.add(key);
            matches.push({ ...symbolSummary(caller), depth });
          }
          next.push(caller.name);
        }
        if (truncated) break;
      }
      if (truncated) break;
      frontier = next;
    }
    return JSON.stringify({ symbolName, maxDepth, matches, truncated }, null, 2);
  }

  async searchSymbols(query: string, kind?: string, limit = 10): Promise<string> {
    const symbols = await this.loadSymbols();
    const queryLower = query.toLowerCase();
    
    let matches = symbols.filter(s => {
      if (kind && s.kind !== kind) return false;
      return s.name.toLowerCase().includes(queryLower);
    });

    // Sort: exact matches first, then startsWith, then others
    matches.sort((a, b) => {
      const aNameLower = a.name.toLowerCase();
      const bNameLower = b.name.toLowerCase();
      
      const aExact = aNameLower === queryLower;
      const bExact = bNameLower === queryLower;
      if (aExact !== bExact) return aExact ? -1 : 1;

      const aStarts = aNameLower.startsWith(queryLower);
      const bStarts = bNameLower.startsWith(queryLower);
      if (aStarts !== bStarts) return aStarts ? -1 : 1;

      return a.name.localeCompare(b.name);
    });

    const total = matches.length;
    matches = matches.slice(0, limit);
    return JSON.stringify({ query, matches: matches.map(symbolSummary), truncated: total > matches.length }, null, 2);
  }

  async getIndexerStatus(): Promise<string> {
    const symbolsPath = path.join(this.repoRoot, ".ai-bridge", "symbols.json");
    try {
      const stat = await fs.stat(symbolsPath);
      const symbols = JSON.parse(await fs.readFile(symbolsPath, "utf8")) as SymbolDefinition[];
      return JSON.stringify({
        kind: "lexical-symbol-cache",
        files: new Set(symbols.map((symbol) => symbol.filePath)).size,
        symbols: symbols.length,
        sizeBytes: stat.size,
        updatedAt: stat.mtime.toISOString(),
      }, null, 2);
    } catch {
      return JSON.stringify({ kind: "lexical-symbol-cache", files: 0, symbols: 0, sizeBytes: 0 }, null, 2);
    }
  }
}

async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function groupSymbolsByFile(symbols: SymbolDefinition[]): Map<string, SymbolDefinition[]> {
  const grouped = new Map<string, SymbolDefinition[]>();
  for (const symbol of symbols) {
    const values = grouped.get(symbol.filePath) ?? [];
    values.push(symbol);
    grouped.set(symbol.filePath, values);
  }
  return grouped;
}

function symbolSummary(symbol: SymbolDefinition): Record<string, unknown> {
  return {
    name: symbol.name,
    kind: symbol.kind,
    path: symbol.filePath,
    startLine: symbol.startLine,
    endLine: symbol.endLine,
    signature: symbol.signature,
  };
}

function dedupeRelationshipSymbols(symbols: SymbolDefinition[]): SymbolDefinition[] {
  const seen = new Set<string>();
  return symbols.filter((symbol) => {
    const key = `${symbol.filePath}:${symbol.startLine}:${symbol.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workerCount = Math.min(Math.max(1, limit), Math.max(1, items.length));

  async function worker(): Promise<void> {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index]);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
