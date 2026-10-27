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
  { tag: tags.comment, color: "#7d8b83" },
  { tag: tags.string, color: "#d4c596" },
  { tag: tags.number, color: "#b6a1e8" },
  {
    tag: [tags.keyword, tags.function(tags.variableName), tags.propertyName],
    color: "#a7c4e5",
  },
  { tag: tags.variableName, color: "#dce2d9" },
  { tag: tags.operator, color: "#b9caab" },
]);
const selectionField = StateField.define({
  create: () => Decoration.none,
  update(value, transaction) {
    value = value.map(transaction.changes);
    for (const effect of transaction.effects)
      if (effect.is(selectedLine)) {
        value =
          effect.value === null
            ? Decoration.none
            : Decoration.set([
                Decoration.line({ class: "cm-clip-line" }).range(
                  transaction.state.doc.line(
                    Math.min(effect.value + 1, transaction.state.doc.lines),
                  ).from,
                ),
              ]);
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
              backgroundColor: "#191b1d",
              color: "#dce2d9",
            },
            ".cm-scroller": {
              overflow: "auto",
              fontFamily: 'Consolas, "Liberation Mono", monospace',
              fontSize: "12px",
              lineHeight: "25px",
            },
            ".cm-content": { padding: "18px 0 60px", caretColor: "#d6fa69" },
            ".cm-line": { padding: "0 14px" },
            ".cm-gutters": {
              backgroundColor: "#191b1d",
              color: "#64716b",
              border: "none",
            },
            ".cm-lineNumbers .cm-gutterElement": {
              padding: "0 8px 0 12px",
              minWidth: "38px",
            },
            ".cm-activeLineGutter": {
              backgroundColor: "#293024",
              color: "#d6fa69",
            },
            ".cm-activeLine": { backgroundColor: "#ffffff04" },
            ".cm-clip-line": {
              backgroundColor: "#d6fa6910",
              boxShadow: "inset 2px 0 #d6fa6980",
            },
            ".cm-cursor": { borderLeftColor: "#d6fa69" },
            ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
              backgroundColor: "#738b4c45",
            },
            ".cm-panels": { backgroundColor: "#242a23", color: "#dbe4d7" },
          },
          { dark: true },
        ),
      ],
    }),
  });
  return {
    getSource: () => view.state.doc.toString(),
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
      if (scroll && line !== null)
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
