---
name: lsp-code-analysis
description: >
  Semantic code analysis via LSP. Navigate code (definitions, references, implementations),
  search symbols, preview refactorings, and get file outlines.
  Use for exploring unfamiliar codebases, understanding code structure, or performing impact analysis.
  Triggers: "find definition", "who calls", "find references", "type of",
  "call hierarchy", "implementations", "code structure", "symbol lookup",
  "what is this", "where is this defined", "show usages",
  or any code navigation task that benefits from language-semantic understanding
  rather than plain text search.
---

# LSP Code Analysis

## Abstract

This skill provides the operational requirements and best practices for the `lsp` tool. It offers a semantic interface to codebase navigation and analysis via the Language Server Protocol (LSP).

## Overview

You are provided with the `lsp` tool for semantic code navigation and analysis. It SHOULD be preferred over `read_file` or `search_content` for most code understanding tasks.

Capabilities:

- **Semantic navigation**: Jump to definitions, find references, locate implementations — understands code structure, not just text patterns.
- **Language-aware**: Distinguishes between variables, functions, classes, types — eliminates false positives from text search.
- **Cross-file intelligence**: Trace dependencies across entire codebase — knows what imports what, who calls whom.
- **Type-aware**: Get precise type information, signatures, documentation — without reading implementation code.

### Tool Selection

**Guideline**: You SHOULD prioritize the `lsp` tool for code navigation and analysis. Use `read_file` or `search_content` ONLY when semantic analysis is not applicable (e.g., searching for comments, literal strings, or log messages).

Match the user's **natural phrasing** to an operation — do NOT default to `search_content` + `read_file` just because it's familiar. Match **both English and Chinese** phrasing.

| User asks about... | Example phrasing | Traditional (wrong) fallback | Correct LSP operation |
|------|------|------|------|
| **File structure / outline** | "list functions in Hero.jsx", "what's defined in this file", "show me the classes in Y", "列出 X 里的函数 / 类" | `read_file` entire file | `documentSymbol` |
| **Type / signature / return value / docs of a FUNCTION** | "return type of App", "signature of X", "what does foo return", "docs for Y", "X 的返回值 / 签名 / 文档" | `read_file` + eyeball | `hover` on function |
| **Type of a FIELD / PROPERTY / MEMBER VARIABLE** ⭐ | "type of Docker.volumes", "what type is user.email", "Docker 类的 volumes 成员变量的类型 / 类型定义", "X 类的 Y 字段是什么类型", "type definition of member variable Z" | `read_file` the class file and eyeball the field | `hover` on `Class.field` (see the inferred type)  **or**  `goToDefinition` on `Class.field` (jump to the declaration site, then follow to the type) |
| **Where a function / class is defined — you only know the NAME** ⭐ | "where is getRandomStr defined", "which file defines function X", "X 函数在哪定义 / 是在哪定义的 / 从哪来的" | `search_content "function X"` / `"const X ="` / `"class X"` (grep the source pattern) — noisy, breaks on syntax variants | `workspaceSymbol query="X"` — one call, exact answer |
| **Where a symbol is defined — you have a FILE that uses it** | "where is useState imported from", "jump to definition of Y in this file", "in file A, where is Y defined" | `search_content` for imports | `goToDefinition` with `find: "<|>X"` (no need to know the exact line) |
| **All usages / callers** | "who calls X", "where is X used", "find references to Y", "谁调用了 X / X 在哪被用" | `search_content` (grep) | `findReferences` |
| **Interface implementations** | "which classes implement IFoo", "who implements this", "哪些类实现了 IFoo" | `search_content` | `goToImplementation` |
| **Call chain in/out** | "what does X call", "who calls into X", "X 的调用链" | manual file reading | `incomingCalls` / `outgoingCalls` |
| **Find symbol by name repo-wide** | "find a class named Controller", "search for function initApp", "全仓库找叫 X 的类 / 函数" | `search_content` on class/function keyword | `workspaceSymbol` |
| **Read the exact body of one symbol** | "show me the body of foo", "read just the UserService class", "只读 X 这个函数 / 类的代码" | `read_file` whole file | `readSymbol` |

> **⭐ Field-type queries are the most commonly mis-routed.** When a user asks about the type of a class member (field, property, member variable), **do not** open the whole file to read the class declaration. Use `hover` with `scope="ClassName.fieldName"` — it returns the inferred type in one call. If the user explicitly asks for the *definition of that type* (not just the type name), then chain: `hover` → identify the type name → `goToDefinition` / `workspaceSymbol` on the type.

## Commands

### Locating Symbols (scope + find)

Most operations use a unified two-step locating syntax:

**Parameters**:

- `filePath`: Path to the file (required for all except `workspaceSymbol`)
- `scope`: Narrow search to a symbol body or line range
- `find`: Text pattern to pinpoint exact position within scope

**Scope Formats**:

- `"MyClass.myMethod"` — symbol path (RECOMMENDED for classes, functions, methods, **and class fields / properties / member variables**; e.g. `"Docker.volumes"`, `"User.profile.email"` — most robust, no line numbers needed)
- `"42"` — single line number (1-based)
- `"10,20"` — line range inclusive (use `"10,0"` for "line 10 to EOF")

**Find Pattern**:

The `find` parameter narrows the target to a **text pattern within the selected scope**:

- Pattern matching is **whitespace-insensitive**: differences in spaces, tabs, and newlines are ignored.
- You MAY include the cursor marker `<|>` inside the pattern to specify the **exact position of interest** (e.g., `user.<|>name` to target the `name` property).
- If `<|>` is omitted, the position defaults to the start of the match.
- If `find` is omitted entirely, the command uses the start of the scope as the navigation target.

**Cursor Marker (`<|>`)**:

The `<|>` marker indicates the exact position for symbol resolution. It represents the character immediately to its right.

**Examples**:

- `scope="MyClass.myMethod", find="self.<|>logger"` — target `logger` property inside `myMethod`
- `scope="42", find="return <|>result"` — target `result` on line 42
- `scope="10,20", find="if <|>condition"` — target `condition` in lines 10-20
- `scope="MyClass"` — target the `MyClass` symbol directly (no find needed)

**Guideline for Scope vs. Find**:

- Use `scope=<symbol.path>` (e.g., `"MyClass"`, `"MyClass.myMethod"`, **`"MyClass.myField"`**) to target **classes, functions, methods, or class fields / properties / member variables**. This is the most robust and preferred approach.
- Use `find` (often combined with `scope`) to target local variables or specific positions within a code block.
- Use `locate` operation to verify if a target exists before running expensive operations like `findReferences`.

### Outline: File Structure

Get hierarchical symbol structure without reading implementation.

```
operation: "documentSymbol"
filePath: "src/models.ts"
```

- Default `verbose="main"` → high-level kinds only (Class, Interface, Enum, Function, Method, Constructor, Namespace, Module, Struct)
- Pass `verbose="all"` to include Variable, Field, Property

Agents SHOULD use `documentSymbol` before reading files to avoid unnecessary context consumption.

### Definition: Navigate to Source

Navigate to where symbols are defined.

```
operation: "goToDefinition"
filePath: "models.ts", scope: "User.getId"

operation: "goToDefinition"
filePath: "main.ts", scope: "42", find: "<|>config"

operation: "goToImplementation"
filePath: "interfaces.ts", scope: "IDataProvider"
```

### Reference: Find All Usages

Find where symbols are used across the codebase.

```
operation: "findReferences"
filePath: "main.ts", scope: "MyClass.run", find: "<|>logger"

operation: "findReferences"
filePath: "api.ts", scope: "IDataProvider"

operation: "findReferences"
filePath: "utils.ts", find: "<|>helper", maxItems: 50, offset: 0
```

- Supports `contextLines` (default 2, max 10) — surrounding lines per reference
- Results are annotated with the **enclosing symbol** for context

### Hover: Get Documentation & Types

Get documentation and type information without navigating to source. **Works for functions AND for class fields / properties / member variables** — this is the fastest way to answer "what type is X" questions.

```
operation: "hover"
filePath: "main.ts", scope: "42"

operation: "hover"
filePath: "models.ts", scope: "processData"

# Type of a class field / member variable (⭐ commonly mis-routed to read_file):
operation: "hover"
filePath: "src/docker/docker.ts", scope: "Docker.volumes"

operation: "hover"
filePath: "app.ts", scope: "MyClass.init", find: "<|>config"
```

Agents SHOULD prefer `hover` over `read_file` when only documentation or type information is needed — including field / property / member-variable types.

### Search: Global Symbol Search

Search for symbols across the workspace when location is unknown. **This is the FASTEST way to answer "where is function/class X defined?"** — do NOT `grep "function X"` or `grep "const X ="`; call `workspaceSymbol` directly. One call, exact answer, no false positives from strings or comments.

```
# ⭐ "where is getRandomStr defined?" / "getRandomStr 函数在哪定义?" — the canonical use:
operation: "workspaceSymbol"
query: "getRandomStr"

operation: "workspaceSymbol"
query: "UserService"

operation: "workspaceSymbol"
query: "init", kinds: ["function", "method"]

operation: "workspaceSymbol"
query: "Config", maxItems: 20
```

- Use `kinds` to filter results: class, method, function, interface, enum, struct, namespace, module, constructor, property, field, variable, constant
- Agents SHOULD use `kinds` to reduce noise on common names (e.g. `kinds=["function"]` when the user explicitly said "function X").
- If the caller ALREADY knows a file that uses the symbol, prefer `goToDefinition` with `find: "<|>X"` on that file — it's one hop and skips workspace-wide search.

### ReadSymbol: Get Complete Symbol Code

Get the full source code of a symbol without reading the entire file.

```
operation: "readSymbol"
filePath: "utils.ts", scope: "UserClass"

operation: "readSymbol"
filePath: "models.ts", scope: "User.validate"

operation: "readSymbol"
filePath: "main.ts", scope: "10,30"
```

Returns dedented + numbered code block for the symbol body. Agents SHOULD use `readSymbol` to read targeted code blocks instead of `read_file` on entire files.

### Call Hierarchy: Trace Call Chains

Trace function call relationships.

```
operation: "prepareCallHierarchy"
filePath: "service.ts", scope: "processOrder"

operation: "incomingCalls"
filePath: "service.ts", scope: "processOrder"

operation: "outgoingCalls"
filePath: "service.ts", scope: "processOrder"
```

### Locate: Verify Position

Resolve scope+find to a line/column with a snippet. Cheap operation — no LSP provider needed.

```
operation: "locate"
filePath: "main.ts", scope: "42", find: "<|>processData"
```

Use `locate` to verify a target exists before running expensive operations.

## Pagination (findReferences / workspaceSymbol)

Both return **one page at a time** to keep context small:

- `resultCount`: items on THIS page
- `totalCount`: total items matching the query
- `hasMore`: `true` if more items exist beyond this page
- `nextOffset`: pass this as `offset` on the next call

**Workflow**: Read page 1 first; if `hasMore` is `true` AND you still need more data, call the SAME operation again with `offset=<nextOffset>` (and identical query/scope/maxItems). Do NOT raise `maxItems` just to see more results — prefer paging.

## Best Practices

### Understanding Unfamiliar Code

The RECOMMENDED sequence for exploring new codebases:

```
Step 1: Outline — Get file structure without reading implementation
  → documentSymbol on the entry file

Step 2: Doc — Inspect API contracts/types
  → hover on key symbols

Step 3: Definition — Jump to source when you must read implementation
  → goToDefinition to follow the chain

Step 4: Reference — See who uses it (impact analysis)
  → findReferences with contextLines for context
```

### Debugging Unknown Behavior

```
Step 1: Locate the symbol workspace-wide
  → workspaceSymbol with the symbol name

Step 2: Verify implementation details
  → goToDefinition to the source

Step 3: Trace all callers to understand invocation context
  → findReferences or incomingCalls
```

### Finding Interface Implementations

```
Step 1: Locate interface definition
  → workspaceSymbol query="IUserService", kinds=["interface"]

Step 2: Find all implementations
  → goToImplementation on the interface
  or: findReferences on the interface symbol
```

### Tracing Data Flow

```
Step 1: Find where a type/class is defined
  → workspaceSymbol query="UserDTO", kinds=["class"]

Step 2: Find where it's used
  → findReferences on the class

Step 3: Check transformations
  → hover on transform functions for type signatures
```

### Performance Tips

- Use `documentSymbol` instead of reading entire files — get structure first, read targeted symbols later.
- Use symbol paths (`scope="User.Profile.validate"`) for nested structures — more precise than line numbers and resistant to code changes.
- Use `readSymbol` instead of `read_file` when you only need one function/class body.
- Use `hover` to understand APIs without navigating to source.
- Limit results in large codebases with `maxItems` and use pagination.
- Run `locate` first if uncertain about a target — it's cheap and returns a verifiable snippet.

## Fallback Strategy

If LSP returns empty results or errors, DO NOT retry the same operation. Fall back in order:

1. Try `workspaceSymbol` with a shorter/broader query
2. Use `search_content` regex over the codebase
3. Use `search_file` if you only know the file-name pattern

**Rule**: 1 failed LSP attempt on a given target → switch to fallback tools immediately.
