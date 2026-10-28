import { compile, DEFAULT_SOURCE } from "./engine.mjs";

const fingerprint = (project) =>
  JSON.stringify([project.source, project.lastValid]);

export class DocumentStore {
  #history = [];
  #index = 0;
  #saved = "";
  #listeners = new Set();
  #coalesce = null;
  #lastEdit = 0;
  constructor(
    source = DEFAULT_SOURCE,
    { lastValid = DEFAULT_SOURCE, dirty = false } = {},
  ) {
    this.load({ source, lastValid }, { dirty });
  }
  get source() {
    return this.#history[this.#index].source;
  }
  get lastValid() {
    return this.#history[this.#index].lastValid;
  }
  get selected() {
    return this.#history[this.#index].selected;
  }
  get selectedIds() {
    return [...this.#history[this.#index].selectedIds];
  }
  get canUndo() {
    return this.#index > 0;
  }
  get canRedo() {
    return this.#index < this.#history.length - 1;
  }
  get dirty() {
    return fingerprint(this.serialize()) !== this.#saved;
  }
  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  #emit(type, label = "") {
    for (const listener of this.#listeners) listener({ type, label });
  }
  #evaluate() {
    try {
      this.model = compile(this.source);
      this.error = null;
      this.#history[this.#index].lastValid = this.source;
    } catch (error) {
      this.error = error;
      this.model = compile(this.lastValid);
    }
    const snapshot = this.#history[this.#index];
    snapshot.selectedIds = snapshot.selectedIds.filter((id) =>
      this.model.clips.some((c) => c.id === id),
    );
    if (!snapshot.selectedIds.includes(snapshot.selected))
      snapshot.selected = snapshot.selectedIds.at(-1) || null;
  }
  serialize() {
    return {
      format: "framecode-project",
      version: 1,
      source: this.source,
      lastValid: this.lastValid,
    };
  }
  load(project, { dirty = false } = {}) {
    if (
      typeof project.source !== "string" ||
      typeof project.lastValid !== "string"
    )
      throw new Error("Invalid project document.");
    compile(project.lastValid);
    this.#history = [
      {
        source: project.source,
        lastValid: project.lastValid,
        selected: null,
        selectedIds: [],
      },
    ];
    this.#index = 0;
    this.#coalesce = null;
    this.#evaluate();
    this.#saved = dirty ? "" : fingerprint(this.serialize());
    this.#emit("load");
  }
  select(id, { toggle = false, add = false } = {}) {
    if (!this.model.clips.some((c) => c.id === id)) id = null;
    let ids = (toggle || add) && id ? this.selectedIds : [];
    if (id) {
      if (toggle && ids.includes(id)) ids = ids.filter((key) => key !== id);
      else if (!ids.includes(id)) ids.push(id);
    }
    const selected = ids.includes(id) ? id : ids.at(-1) || null;
    if (
      JSON.stringify(ids) === JSON.stringify(this.selectedIds) &&
      selected === this.selected
    )
      return;
    Object.assign(this.#history[this.#index], { selected, selectedIds: ids });
    this.#emit("selection");
  }
  commit(
    source,
    {
      label = "Edit composition",
      coalesce = null,
      selected = this.selected,
    } = {},
  ) {
    if (typeof source !== "string" || source.length > 50000)
      throw new Error("Keep source under 50,000 characters.");
    if (source === this.source) {
      if (selected !== this.selected) this.select(selected);
      return false;
    }
    const next = {
        source,
        lastValid: this.lastValid,
        selected,
        selectedIds:
          selected === this.selected
            ? this.selectedIds
            : selected
              ? [selected]
              : [],
      },
      now = Date.now();
    const merge =
      coalesce &&
      coalesce === this.#coalesce &&
      now - this.#lastEdit < 650 &&
      this.#index === this.#history.length - 1;
    if (merge) this.#history[this.#index] = next;
    else {
      this.#history = this.#history.slice(0, this.#index + 1);
      this.#history.push(next);
      if (this.#history.length > 150) this.#history.shift();
      this.#index = this.#history.length - 1;
    }
    this.#coalesce = coalesce;
    this.#lastEdit = now;
    this.#evaluate();
    this.#emit("edit", label);
    return true;
  }
  undo() {
    if (!this.canUndo) return false;
    this.#index--;
    this.#coalesce = null;
    this.#evaluate();
    this.#emit("undo");
    return true;
  }
  redo() {
    if (!this.canRedo) return false;
    this.#index++;
    this.#coalesce = null;
    this.#evaluate();
    this.#emit("redo");
    return true;
  }
  markSaved(project = this.serialize()) {
    this.#saved = fingerprint(project);
    this.#coalesce = null;
    this.#emit("saved");
  }
}
