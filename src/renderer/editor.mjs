import {
  EditorState,
  StateEffect,
  StateField,
  Annotation,
  Compartment,
} from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  Decoration,
} from "@codemirror/view";
import { defaultKeymap, indentWithTab } from "@codemirror/commands";
import {
  syntaxHighlighting,
  HighlightStyle,
  bracketMatching,
} from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { javascript } from "@codemirror/lang-javascript";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";

const selectedLine = StateEffect.define(),
  programmatic = Annotation.define();
const colors = HighlightStyle.define([
  { tag: tags.comment, color: "#8b9691" },
  { tag: tags.string, color: "#d4c596" },
  { tag: tags.number, color: "#b6a1e8" },
  {
    tag: [tags.keyword, tags.function(tags.variableName), tags.propertyName],
    color: "#a7c4e5",
  },
  { tag: tags.variableName, color: "#e9ece8" },
  { tag: tags.operator, color: "#b9caab" },
]);
const selectionField = StateField.define({
  create: () => Decoration.none,
  update(value, transaction) {
    value = value.map(transaction.changes);
    for (const effect of transaction.effects)
      if (effect.is(selectedLine)) {
        const lines = Array.isArray(effect.value)
          ? effect.value
          : effect.value === null
            ? []
            : [effect.value];
        value = Decoration.set(
          [...new Set(lines)]
            .sort((a, b) => a - b)
            .map((line) =>
              Decoration.line({ class: "cm-clip-line" }).range(
                transaction.state.doc.line(
                  Math.min(line + 1, transaction.state.doc.lines),
                ).from,
              ),
            ),
        );
      }
    return value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

export function createEditor(
  parent,
  { source, onChange, onLine, onUndo, onRedo, onRun, onError },
) {
  const editable = new Compartment();
  let readOnly = false;
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: source,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        drawSelection(),
        javascript(),
        bracketMatching(),
        closeBrackets(),
        highlightSelectionMatches(),
        syntaxHighlighting(colors),
        selectionField,
        editable.of([
          EditorView.editable.of(true),
          EditorState.readOnly.of(false),
        ]),
        EditorView.contentAttributes.of({
          "aria-label": "Composition source code",
          spellcheck: "false",
        }),
        EditorState.transactionFilter.of((transaction) => {
          if (transaction.newDoc.length > 50000) {
            onError("Keep compositions under 50,000 characters.");
            return [];
          }
          return transaction;
        }),
        keymap.of([
          {
            key: "Mod-z",
            run: () => {
              onUndo();
              return true;
            },
          },
          {
            key: "Mod-Shift-z",
            run: () => {
              onRedo();
              return true;
            },
          },
          {
            key: "Mod-y",
            run: () => {
              onRedo();
              return true;
            },
          },
          {
            key: "Mod-Enter",
            run: () => {
              onRun();
              return true;
            },
          },
          indentWithTab,
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...searchKeymap,
        ]),
        EditorView.updateListener.of((update) => {
          if (
            update.docChanged &&
            !update.transactions.some((transaction) =>
              transaction.annotation(programmatic),
            )
          )
            onChange(update.state.doc.toString());
          if (
            update.selectionSet &&
            !update.transactions.some((transaction) =>
              transaction.annotation(programmatic),
            )
          ) {
            const line =
              update.state.doc.lineAt(update.state.selection.main.head).number -
              1;
            queueMicrotask(() => onLine(line));
          }
        }),
        EditorView.theme(
          {
            "&": {
              height: "100%",
              backgroundColor: "#121516",
              color: "#e9ece8",
            },
            ".cm-scroller": {
              overflow: "auto",
              fontFamily: 'Consolas, "Cascadia Mono", "Liberation Mono", monospace',
              fontSize: "12.5px",
              lineHeight: "20px",
            },
            ".cm-content": { padding: "14px 0 48px", caretColor: "#d6fa69" },
            ".cm-line": { padding: "0 12px" },
            ".cm-gutters": {
              backgroundColor: "#121516",
              color: "#6f7a75",
              border: "none",
            },
            ".cm-lineNumbers .cm-gutterElement": {
              padding: "0 8px 0 10px",
              minWidth: "34px",
            },
            ".cm-activeLineGutter": {
              backgroundColor: "#1b1f21",
              color: "#d6fa69",
            },
            ".cm-activeLine": { backgroundColor: "#ffffff05" },
            ".cm-clip-line": {
              backgroundColor: "#d6fa6910",
              boxShadow: "inset 2px 0 #d6fa6980",
            },
            ".cm-cursor": { borderLeftColor: "#d6fa69" },
            ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
              backgroundColor: "#d6fa6926",
            },
            ".cm-panels": { backgroundColor: "#1b1f21", color: "#e9ece8" },
          },
          { dark: true },
        ),
      ],
    }),
  });
  return {
    getSource: () => view.state.doc.toString(),
    refresh() {
      view.requestMeasure();
    },
    setSource(next) {
      if (next === view.state.doc.toString()) return;
      const selection = view.state.selection.main;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: next },
        selection: {
          anchor: Math.min(selection.anchor, next.length),
          head: Math.min(selection.head, next.length),
        },
        annotations: programmatic.of(true),
      });
    },
    highlightLine(line, { scroll = false } = {}) {
      const effects = [selectedLine.of(line)];
      if (scroll && line !== null && !Array.isArray(line))
        effects.push(
          EditorView.scrollIntoView(
            view.state.doc.line(Math.min(line + 1, view.state.doc.lines)).from,
            { y: "nearest" },
          ),
        );
      view.dispatch({ effects });
    },
    focus: () => view.focus(),
    setReadOnly(value) {
      if (value === readOnly) return;
      readOnly = value;
      view.dispatch({
        effects: editable.reconfigure([
          EditorView.editable.of(!value),
          EditorState.readOnly.of(value),
        ]),
      });
    },
    destroy: () => view.destroy(),
  };
}
