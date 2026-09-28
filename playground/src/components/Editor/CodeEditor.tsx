import React, { useRef } from 'react';
import Editor, { type OnMount, type BeforeMount, loader } from '@monaco-editor/react';
import { useStudio } from '../../context/StudioContext';

// Ensure Monaco loader points to reliable CDN
loader.config({
  paths: {
    vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/min/vs',
  },
});

// Configure defaults before any worker or model is created
loader.init().then((monaco) => {
  monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: true,
    noSyntaxValidation: true,
    noSuggestionDiagnostics: true,
  });
  monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: true,
    noSyntaxValidation: true,
    noSuggestionDiagnostics: true,
  });
}).catch(() => {});

export const CodeEditor: React.FC = () => {
  const { activeTab, updateActiveCode, activeTheme, executeCode, tables } = useStudio();
  const editorRef = useRef<any>(null);
  const tablesRef = useRef(tables);
  tablesRef.current = tables;
  const executeCodeRef = useRef(executeCode);
  executeCodeRef.current = executeCode;
  const updateActiveCodeRef = useRef(updateActiveCode);
  updateActiveCodeRef.current = updateActiveCode;

  const handleBeforeMount: BeforeMount = (monaco) => {
    monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
      noSemanticValidation: true,
      noSyntaxValidation: true,
      noSuggestionDiagnostics: true,
    });
    monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
      noSemanticValidation: true,
      noSyntaxValidation: true,
      noSuggestionDiagnostics: true,
    });
    monaco.languages.typescript.javascriptDefaults.setCompilerOptions({
      target: monaco.languages.typescript.ScriptTarget.ES2020,
      allowNonTextFiles: true,
      allowJs: true,
      checkJs: false,
    });
    monaco.languages.typescript.typescriptDefaults.setCompilerOptions({
      target: monaco.languages.typescript.ScriptTarget.ES2020,
      allowNonTextFiles: true,
      allowJs: true,
      checkJs: false,
    });
  };

  const handleEditorMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;

    // Register WebDB Completion Item Provider
    monaco.languages.registerCompletionItemProvider('javascript', {
      triggerCharacters: ['.', '"', "'", '(', ' '],
      provideCompletionItems: (model, position) => {
        const lineContent = model.getLineContent(position.lineNumber);
        const textUntilPosition = lineContent.substring(0, position.column - 1);
        const suggestions: any[] = [];

        // 1. After 'db.' -> WebDB methods
        if (/\bdb\.\s*$/.test(textUntilPosition)) {
          suggestions.push(
            {
              label: 'from',
              kind: monaco.languages.CompletionItemKind.Method,
              insertText: 'from("${1:tableName}")',
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              documentation: "Start a query on a database table.\nExample: db.from('products')",
            },
            {
              label: 'registerFunction',
              kind: monaco.languages.CompletionItemKind.Method,
              insertText: 'registerFunction("${1:fnName}", (${2:arg}) => {\n  ${3:return arg;}\n})',
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              documentation: 'Register a custom JavaScript User-Defined Function (UDF).',
            },
            {
              label: 'insert',
              kind: monaco.languages.CompletionItemKind.Method,
              insertText: 'insert("${1:tableName}", ${2:rowObject})',
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              documentation: 'Insert a new row into the specified table.',
            },
            {
              label: 'createTable',
              kind: monaco.languages.CompletionItemKind.Method,
              insertText:
                'createTable("${1:tableName}", [\n  { name: "${2:id}", type: "INT32", flags: { primaryKey: true, notNull: true } },\n  { name: "${3:title}", type: "TEXT", flags: { notNull: true } }\n])',
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              documentation: 'Create a new table with typed column definitions.',
            },
            {
              label: 'getTable',
              kind: monaco.languages.CompletionItemKind.Method,
              insertText: 'getTable("${1:tableName}")',
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              documentation: 'Retrieve table metadata descriptor and column schema.',
            },
            {
              label: 'listTables',
              kind: monaco.languages.CompletionItemKind.Method,
              insertText: 'listTables()',
              documentation: 'List all active tables and schemas in the database.',
            },
            {
              label: 'explainQuery',
              kind: monaco.languages.CompletionItemKind.Method,
              insertText: 'explainQuery("${1:tableName}", ${2:filters})',
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              documentation: 'Compile and inspect query execution plan and VDBE bytecode.',
            },
            {
              label: 'close',
              kind: monaco.languages.CompletionItemKind.Method,
              insertText: 'close()',
              documentation: 'Flush all dirty buffer pages and close storage VFS.',
            },
          );
        }
        // 2. Inside db.from("...") -> Table names
        else if (/\bdb\.from\(\s*["']?[a-zA-Z0-9_]*$/.test(textUntilPosition)) {
          for (const t of tablesRef.current) {
            suggestions.push({
              label: `"${t.name}"`,
              kind: monaco.languages.CompletionItemKind.Value,
              insertText: `"${t.name}"`,
              documentation: `Table: ${t.name} (~${t.rowCountEstimate} rows)`,
            });
          }
        }
        // 3. Inside column argument
        else if (
          /\.(where|whereNull|whereNotNull|orderBy|groupBy|select)\(\s*["']?[a-zA-Z0-9_]*$/.test(
            textUntilPosition,
          )
        ) {
          const colNames = new Set([
            'id',
            'category_id',
            'title',
            'brand',
            'price',
            'cost',
            'stock',
            'rating',
            'name',
            'department',
            'item_count',
            'email',
            'country',
            'tier',
            'lifetime_spent',
            'customer_id',
            'status',
            'order_date',
            'total_amount',
            'tax',
            'shipping_cost',
            'items_count',
            'product_id',
            'verified_purchase',
            'headline',
          ]);
          for (const c of colNames) {
            suggestions.push({
              label: `"${c}"`,
              kind: monaco.languages.CompletionItemKind.Field,
              insertText: `"${c}"`,
              documentation: `Column field: ${c}`,
            });
          }
        }
        // 4. QueryBuilder methods
        else if (/\.\s*$/.test(textUntilPosition)) {
          suggestions.push(
            {
              label: 'where',
              kind: monaco.languages.CompletionItemKind.Method,
              insertText: 'where("${1:column}", "${2:=}", ${3:value})',
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              documentation: 'Filter records with comparison predicate (=, !=, <, <=, >, >=, LIKE).',
            },
            {
              label: 'select',
              kind: monaco.languages.CompletionItemKind.Method,
              insertText: 'select([${1:"*"}])',
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              documentation: 'Project specific column fields or expressions.',
            },
            {
              label: 'orderBy',
              kind: monaco.languages.CompletionItemKind.Method,
              insertText: 'orderBy("${1:column}", "${2:desc}")',
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              documentation: 'Sort results by column (asc | desc).',
            },
            {
              label: 'limit',
              kind: monaco.languages.CompletionItemKind.Method,
              insertText: 'limit(${1:25})',
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              documentation: 'Constrain maximum result rows returned.',
            },
            {
              label: 'offset',
              kind: monaco.languages.CompletionItemKind.Method,
              insertText: 'offset(${1:0})',
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              documentation: 'Skip initial N rows.',
            },
            {
              label: 'explain',
              kind: monaco.languages.CompletionItemKind.Method,
              insertText: 'explain()',
              documentation: 'Compile query to VDBE bytecode without executing.',
            },
            {
              label: 'toArray',
              kind: monaco.languages.CompletionItemKind.Method,
              insertText: 'toArray()',
              documentation: 'Execute query VM and return result rows as array.',
            },
          );
        }

        return { suggestions };
      },
    });

    // Bind Cmd+Enter / Ctrl+Enter to execute query
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
      const currentCode = editor.getValue();
      updateActiveCodeRef.current(currentCode);
      executeCodeRef.current(currentCode);
    });
  };

  const currentTabId = activeTab?.id || 'tab-1';

  return (
    <div
      id="editorContainer"
      style={{
        flex: 1,
        width: '100%',
        height: '100%',
        minHeight: 0,
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <Editor
        key={currentTabId}
        path={`file:///workspace/${currentTabId}.js`}
        height="100%"
        width="100%"
        defaultLanguage="javascript"
        language="javascript"
        theme={activeTheme === 'light' ? 'vs' : 'vs-dark'}
        value={activeTab?.code || ''}
        onChange={(val) => updateActiveCode(val || '')}
        beforeMount={handleBeforeMount}
        onMount={handleEditorMount}
        loading={
          <div
            style={{
              padding: '20px',
              color: 'var(--text-muted)',
              fontSize: '0.75rem',
              fontFamily: 'var(--font-mono)',
            }}
          >
            Loading editor...
          </div>
        }
        options={{
          fontSize: 12.5,
          fontFamily: 'var(--font-mono)',
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          automaticLayout: true,
          renderLineHighlight: 'line',
          lineNumbersMinChars: 3,
          tabSize: 2,
          padding: { top: 8, bottom: 8 },
        }}
      />
    </div>
  );
};
