//! A conservative Rust port of the composition engine's compiler
//! (`src/core/engine.mjs`), used where the backend must understand
//! compositions without a JavaScript runtime (Stage 4 asset scanning).
//!
//! The engine is the source of truth. This module reproduces:
//!
//! - the line parser: blank and `//`-comment lines are skipped, every
//!   other line must be one call chain (`name(args).chain(args)`), and
//!   the chain grammar (dot rules, quoted-argument state machines) is
//!   matched exactly;
//! - the argument grammar: a quoted JSON string, a JSON number, or a
//!   `$parameter` reference — so Windows paths keep their JSON escapes
//!   (`\\`, `\"`, `\uXXXX`) and everything else fails like the engine;
//! - the per-kind allowed-method matrix, argument counts, uniqueness
//!   rules, `$parameter` resolution, and every validation `compile`
//!   performs, in the same order (error strings match the engine's, with
//!   the failing line appended where the engine attaches it as `e.line`).
//!
//! Anything the engine would reject fails here too, so authorization
//! scanning is fail-closed: a composition that does not compile
//! contributes no image paths at all, and `.source()` arguments on
//! non-image clips are parse errors just like in the engine — never
//! candidates.
//!
//! The only exposed outcome is the one scanning needs: the resolved
//! `source` of every valid image clip.

use std::collections::{HashMap, HashSet};

/// One parsed call argument: a `$parameter` reference, a JSON string,
/// or a JSON number — exactly the grammar the engine's `parseArg`
/// accepts (`JSON.parse` applies, so strings use JSON escapes).
#[derive(Debug, Clone, PartialEq)]
enum Arg {
    Ref(String),
    Str(String),
    Num(f64),
}

/// A resolved value: what an argument becomes after `$parameter`
/// resolution (parameters hold strings or numbers only).
#[derive(Debug, Clone, PartialEq)]
enum Val {
    Str(String),
    Num(f64),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Scene,
    Text,
    Shape,
    Image,
    Video,
    Audio,
}

/// The asset-bearing clip kinds, as the authorization layer needs them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClipKind {
    Image,
    Video,
    Audio,
}

/// One resolved asset path and the kind of clip that references it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClipSource {
    pub kind: ClipKind,
    pub path: String,
}

struct Call {
    name: String,
    args: Vec<Arg>,
}

struct RawClip {
    id: String,
    kind: Kind,
    line: usize,
    at: Option<Arg>,
    for_: Option<Arg>,
    value: Option<Arg>,
    place: Option<Arg>,
    motion: Option<Arg>,
    look: Option<Arg>,
    color: Option<Arg>,
    source: Option<Arg>,
    fit: Option<Arg>,
    source_at: Option<Arg>,
    source_duration: Option<Arg>,
    gain: Option<Arg>,
    scale: Option<Arg>,
    rotation: Option<Arg>,
    opacity: Option<Arg>,
    hidden: Option<Arg>,
    locked: Option<Arg>,
    label: Option<Arg>,
    position: Option<Vec<Arg>>,
}

impl RawClip {
    fn new(id: String, kind: Kind, line: usize) -> RawClip {
        RawClip {
            id,
            kind,
            line,
            at: None,
            for_: None,
            value: None,
            place: None,
            motion: None,
            look: None,
            color: None,
            source: None,
            fit: None,
            source_at: None,
            source_duration: None,
            gain: None,
            scale: None,
            rotation: None,
            opacity: None,
            hidden: None,
            locked: None,
            label: None,
            position: None,
        }
    }
}

/// The engine's `allowed` matrix: the chain methods each clip kind
/// accepts (plus `label`/`hidden`/`locked` for every kind and `opacity`
/// for every visual kind, applied below).
const ALLOWED: [(Kind, &[&str]); 6] = [
    (
        Kind::Scene,
        &["at", "for", "look", "sourceAt", "sourceDuration"],
    ),
    (
        Kind::Text,
        &[
            "at",
            "for",
            "value",
            "place",
            "motion",
            "position",
            "sourceAt",
            "sourceDuration",
            "scale",
            "rotation",
        ],
    ),
    (
        Kind::Shape,
        &[
            "at",
            "for",
            "color",
            "motion",
            "position",
            "sourceAt",
            "sourceDuration",
            "scale",
            "rotation",
        ],
    ),
    (
        Kind::Image,
        &[
            "at",
            "for",
            "source",
            "fit",
            "position",
            "sourceAt",
            "sourceDuration",
            "scale",
            "rotation",
        ],
    ),
    (
        Kind::Video,
        &[
            "at",
            "for",
            "source",
            "fit",
            "position",
            "sourceAt",
            "sourceDuration",
            "scale",
            "rotation",
        ],
    ),
    (
        Kind::Audio,
        &["at", "for", "source", "gain", "sourceAt", "sourceDuration"],
    ),
];

fn fail(line: usize, message: &str) -> String {
    format!("{message} (line {line})")
}

/// The engine's identifier regex `/^[A-Za-z_][\w]*$/` (ASCII `\w`).
fn is_identifier(name: &str) -> bool {
    let mut chars = name.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// ECMAScript's `String.prototype.trim` whitespace set (WhiteSpace plus
/// LineTerminator). Rust's `char::is_whitespace` differs in two ways that
/// matter here: it excludes U+FEFF (which JS trims) and includes U+0085
/// (which JS does not), so every `.trim()` in the engine's compile path
/// must go through this exact set to stay fail-closed.
fn js_trim(value: &str) -> &str {
    fn is_js_whitespace(c: char) -> bool {
        matches!(
            c,
            '\u{0009}'
                | '\u{000A}'
                | '\u{000B}'
                | '\u{000C}'
                | '\u{000D}'
                | '\u{0020}'
                | '\u{00A0}'
                | '\u{1680}'
                | '\u{2000}'
                ..='\u{200A}'
                    | '\u{2028}'
                    | '\u{2029}'
                    | '\u{202F}'
                    | '\u{205F}'
                    | '\u{3000}'
                    | '\u{FEFF}'
        )
    }
    value.trim_matches(is_js_whitespace)
}

/// The engine's color regex `/^#[0-9a-f]{6}$/i` (case-insensitive).
fn is_hex_color(value: &str) -> bool {
    let chars: Vec<char> = value.chars().collect();
    chars.len() == 7 && chars[0] == '#' && chars[1..].iter().all(|c| c.is_ascii_hexdigit())
}

/// The engine's `parseArg`: `$name` is a parameter reference, everything
/// else must be `JSON.parse`-able as a string or number.
fn parse_arg(raw: &str, line: usize) -> Result<Arg, String> {
    let value = js_trim(raw);
    if let Some(rest) = value.strip_prefix('$') {
        if is_identifier(rest) {
            return Ok(Arg::Ref(rest.to_string()));
        }
    }
    match serde_json::from_str::<serde_json::Value>(value) {
        Ok(serde_json::Value::String(s)) => Ok(Arg::Str(s)),
        Ok(serde_json::Value::Number(n)) => Ok(Arg::Num(n.as_f64().unwrap_or(f64::NAN))),
        _ => Err(fail(
            line,
            "Use a quoted string, a number, or a $parameter.",
        )),
    }
}

/// The engine's `splitArgs`: top-level comma split with quote/escape
/// awareness (escapes only count inside quotes, exactly like JS).
fn split_args(input: &str, line: usize) -> Result<Vec<Arg>, String> {
    if js_trim(input).is_empty() {
        return Ok(Vec::new());
    }
    let bytes = input.as_bytes();
    let mut out = Vec::new();
    let mut start = 0;
    let mut quote = false;
    let mut escape = false;
    for (index, &c) in bytes.iter().enumerate() {
        if escape {
            escape = false;
            continue;
        }
        if c == b'\\' && quote {
            escape = true;
            continue;
        }
        if c == b'"' {
            quote = !quote;
        }
        if c == b',' && !quote {
            out.push(parse_arg(&input[start..index], line)?);
            start = index + 1;
        }
    }
    if quote {
        return Err(fail(line, "Close the quoted string."));
    }
    out.push(parse_arg(&input[start..], line)?);
    Ok(out)
}

/// The engine's `calls`: one call chain, with the dot rules
/// (no dot on the first call, a dot on every later one) and the
/// quoted-argument parenthesis matcher.
fn calls(input: &str, line: usize) -> Result<Vec<Call>, String> {
    let bytes = input.as_bytes();
    let mut pos = 0;
    let mut out: Vec<Call> = Vec::new();
    while pos < bytes.len() {
        let dot = bytes[pos] == b'.';
        let mut cursor = pos + usize::from(dot);
        let name_start = cursor;
        while cursor < bytes.len() && bytes[cursor].is_ascii_alphabetic() {
            cursor += 1;
        }
        if cursor == name_start || cursor >= bytes.len() || bytes[cursor] != b'(' {
            return Err(fail(line, "Expected a function call, such as .at(0)."));
        }
        let name = &input[name_start..cursor];
        if (out.is_empty() && dot) || (!out.is_empty() && !dot) {
            return Err(fail(line, "Chain methods with a dot."));
        }
        cursor += 1;
        let args_start = cursor;
        let mut quoted = false;
        let mut escaped = false;
        while cursor < bytes.len() {
            if escaped {
                escaped = false;
                cursor += 1;
                continue;
            }
            if bytes[cursor] == b'\\' && quoted {
                escaped = true;
                cursor += 1;
                continue;
            }
            if bytes[cursor] == b'"' {
                quoted = !quoted;
            }
            if bytes[cursor] == b')' && !quoted {
                break;
            }
            cursor += 1;
        }
        if cursor == bytes.len() {
            return Err(fail(line, "Close the function with a parenthesis."));
        }
        out.push(Call {
            name: name.to_string(),
            args: split_args(&input[args_start..cursor], line)?,
        });
        pos = cursor + 1;
    }
    Ok(out)
}

/// Applies one validated chain call to the clip, exactly like the
/// engine's `clip[call.name] = ...` assignment.
fn assign(clip: &mut RawClip, call: &Call) {
    let single = call.args[0].clone();
    match call.name.as_str() {
        "at" => clip.at = Some(single),
        "for" => clip.for_ = Some(single),
        "value" => clip.value = Some(single),
        "place" => clip.place = Some(single),
        "motion" => clip.motion = Some(single),
        "look" => clip.look = Some(single),
        "color" => clip.color = Some(single),
        "source" => clip.source = Some(single),
        "fit" => clip.fit = Some(single),
        "sourceAt" => clip.source_at = Some(single),
        "sourceDuration" => clip.source_duration = Some(single),
        "gain" => clip.gain = Some(single),
        "scale" => clip.scale = Some(single),
        "rotation" => clip.rotation = Some(single),
        "opacity" => clip.opacity = Some(single),
        "hidden" => clip.hidden = Some(single),
        "locked" => clip.locked = Some(single),
        "label" => clip.label = Some(single),
        "position" => clip.position = Some(call.args.clone()),
        _ => {}
    }
}

/// The engine's `resolve`: `$name` must exist among the parameters.
fn resolve(arg: &Arg, params: &HashMap<String, Val>, line: usize) -> Result<Val, String> {
    match arg {
        Arg::Str(s) => Ok(Val::Str(s.clone())),
        Arg::Num(n) => Ok(Val::Num(*n)),
        Arg::Ref(name) => params
            .get(name)
            .cloned()
            .ok_or_else(|| fail(line, &format!("Unknown parameter: ${name}."))),
    }
}

/// JavaScript `+` for the two operand shapes the engine can see here:
/// number + number sums, anything with a string concatenates. Only used
/// where the result immediately feeds an isFinite gate, so the string
/// forms are simply a failing marker.
fn js_plus(a: &Val, b: &Val) -> Val {
    match (a, b) {
        (Val::Num(x), Val::Num(y)) => Val::Num(x + y),
        (Val::Str(x), Val::Str(y)) => Val::Str(format!("{x}{y}")),
        (Val::Num(x), Val::Str(y)) => Val::Str(format!("{x}{y}")),
        (Val::Str(x), Val::Num(y)) => Val::Str(format!("{x}{y}")),
    }
}

/// Compiles `source` exactly like the engine and returns every asset-bearing
/// clip's resolved `source` path and kind, in clip order. Any compile
/// failure returns `Err` — callers treat that as "no candidates".
pub fn clip_sources(source: &str) -> Result<Vec<ClipSource>, String> {
    // The engine caps `source.length` (UTF-16 code units).
    if source.encode_utf16().count() > 50000 {
        return Err("Keep the composition under 50,000 characters.".to_string());
    }
    let mut params: HashMap<String, Val> = HashMap::new();
    let mut param_lines: HashMap<String, usize> = HashMap::new();
    let mut has_composition = false;
    let mut duration = 12.0f64;
    let mut clips: Vec<RawClip> = Vec::new();

    for (index, raw) in source.split('\n').enumerate() {
        let line = index + 1;
        let input = js_trim(raw);
        if input.is_empty() || input.starts_with("//") {
            continue;
        }
        let mut parsed = calls(input, line)?;
        let root = parsed.remove(0);
        match root.name.as_str() {
            "composition" => {
                if has_composition {
                    return Err(fail(line, "Use one composition per score."));
                }
                let name_ok =
                    matches!(&root.args.first(), Some(Arg::Str(s)) if !js_trim(s).is_empty());
                if root.args.len() != 1 || !name_ok {
                    return Err(fail(line, "Give the composition a name."));
                }
                has_composition = true;
                for call in &parsed {
                    let number = matches!(call.args.first(), Some(Arg::Num(_)));
                    if call.name != "duration" || call.args.len() != 1 || !number {
                        return Err(fail(line, "Composition supports .duration(seconds)."));
                    }
                    duration = match &call.args[0] {
                        Arg::Num(n) => *n,
                        _ => unreachable!("checked above"),
                    };
                }
            }
            "param" => {
                let name_ok = matches!(&root.args.first(), Some(Arg::Str(s)) if is_identifier(s));
                let value_ok = !matches!(root.args.get(1), Some(Arg::Ref(_)));
                if !parsed.is_empty() || root.args.len() != 2 || !name_ok || !value_ok {
                    return Err(fail(
                        line,
                        "Use param(\"name\", \"value\") or param(\"name\", 1).",
                    ));
                }
                let name = match &root.args[0] {
                    Arg::Str(s) => s.clone(),
                    _ => unreachable!("checked above"),
                };
                if params.contains_key(&name) {
                    return Err(fail(line, "Parameter names must be unique."));
                }
                let value = match &root.args[1] {
                    Arg::Str(s) => Val::Str(s.clone()),
                    Arg::Num(n) => Val::Num(*n),
                    Arg::Ref(_) => unreachable!("checked above"),
                };
                params.insert(name.clone(), value);
                param_lines.insert(name, index);
            }
            "scene" | "text" | "shape" | "image" | "video" | "audio" => {
                let kind = match root.name.as_str() {
                    "scene" => Kind::Scene,
                    "text" => Kind::Text,
                    "shape" => Kind::Shape,
                    "image" => Kind::Image,
                    "video" => Kind::Video,
                    _ => Kind::Audio,
                };
                let id_ok = matches!(
                    &root.args.first(),
                    Some(Arg::Str(s)) if !js_trim(s).is_empty()
                );
                if root.args.len() != 1 || !id_ok {
                    return Err(fail(line, "Give each clip a name."));
                }
                let id = match &root.args[0] {
                    Arg::Str(s) => s.clone(),
                    _ => unreachable!("checked above"),
                };
                if clips.iter().any(|c| c.id == id) {
                    return Err(fail(line, "Clip names must be unique."));
                }
                let mut clip = RawClip::new(id, kind, index);
                let allowed = &ALLOWED
                    .iter()
                    .find(|(k, _)| *k == kind)
                    .expect("every kind has an allowed list")
                    .1;
                let mut seen: HashSet<&str> = HashSet::new();
                for call in &parsed {
                    // The engine's acceptance check: an allowed method for
                    // the kind (plus label/hidden/locked for every kind and
                    // opacity for every visual kind), the exact argument
                    // count, and no repeats. Audio has no visual surface.
                    let accepted = allowed.contains(&call.name.as_str())
                        || matches!(call.name.as_str(), "label" | "hidden" | "locked")
                        || (kind != Kind::Audio && call.name == "opacity");
                    let count_ok = call.args.len() == if call.name == "position" { 2 } else { 1 };
                    if !accepted || !count_ok || seen.contains(call.name.as_str()) {
                        return Err(fail(
                            line,
                            &format!("Unsupported or repeated method: .{}().", call.name),
                        ));
                    }
                    seen.insert(call.name.as_str());
                    assign(&mut clip, call);
                }
                clips.push(clip);
            }
            other => return Err(fail(line, &format!("Unknown function: {other}."))),
        }
    }

    if !has_composition {
        return Err("Start with composition(\"Name\").duration(12).".to_string());
    }
    if !duration.is_finite() || !(1.0..=60.0).contains(&duration) {
        return Err("Duration must be between 1 and 60 seconds.".to_string());
    }
    if clips.len() > 24 {
        return Err("This prototype supports up to 24 clips.".to_string());
    }

    let mut sources: Vec<ClipSource> = Vec::new();
    for clip in &clips {
        let line = clip.line + 1;
        // The engine resolves every listed key first (unknown-parameter
        // failures surface before any value validation), in this order.
        let r_at = resolve(clip.at.as_ref().unwrap_or(&Arg::Num(0.0)), &params, line)?;
        let r_for = resolve(clip.for_.as_ref().unwrap_or(&Arg::Num(12.0)), &params, line)?;
        let r_value = resolve(
            clip.value.as_ref().map_or(&Arg::Str(String::new()), |a| a),
            &params,
            line,
        )?;
        let r_place = resolve(
            clip.place.as_ref().unwrap_or(&Arg::Str("left".to_string())),
            &params,
            line,
        )?;
        let r_motion = resolve(
            clip.motion
                .as_ref()
                .unwrap_or(&Arg::Str("fade".to_string())),
            &params,
            line,
        )?;
        let r_look = resolve(
            clip.look.as_ref().unwrap_or(&Arg::Str("orbit".to_string())),
            &params,
            line,
        )?;
        let r_color = resolve(
            clip.color
                .as_ref()
                .unwrap_or(&Arg::Str("#d6fa69".to_string())),
            &params,
            line,
        )?;
        let r_source = resolve(
            clip.source.as_ref().unwrap_or(&Arg::Str(String::new())),
            &params,
            line,
        )?;
        let r_fit = resolve(
            clip.fit
                .as_ref()
                .unwrap_or(&Arg::Str("contain".to_string())),
            &params,
            line,
        )?;
        let r_source_at = resolve(
            clip.source_at.as_ref().unwrap_or(&Arg::Num(0.0)),
            &params,
            line,
        )?;
        let r_source_duration = match &clip.source_duration {
            Some(arg) => Some(resolve(arg, &params, line)?),
            None => None,
        };
        let r_label = resolve(
            clip.label.as_ref().unwrap_or(&Arg::Str(clip.id.clone())),
            &params,
            line,
        )?;
        let r_hidden = resolve(
            clip.hidden.as_ref().unwrap_or(&Arg::Num(0.0)),
            &params,
            line,
        )?;
        let r_locked = resolve(
            clip.locked.as_ref().unwrap_or(&Arg::Num(0.0)),
            &params,
            line,
        )?;
        let r_scale = resolve(clip.scale.as_ref().unwrap_or(&Arg::Num(1.0)), &params, line)?;
        let r_rotation = resolve(
            clip.rotation.as_ref().unwrap_or(&Arg::Num(0.0)),
            &params,
            line,
        )?;
        let r_opacity = resolve(
            clip.opacity.as_ref().unwrap_or(&Arg::Num(1.0)),
            &params,
            line,
        )?;
        let r_gain = resolve(clip.gain.as_ref().unwrap_or(&Arg::Num(1.0)), &params, line)?;

        // Label: string, 1–160 characters (160 UTF-16 units, like JS).
        let Val::Str(label) = &r_label else {
            return Err(fail(line, "Labels need 1–160 characters."));
        };
        if js_trim(label).is_empty()
            || (r_label != Val::Str(clip.id.clone()) && label.encode_utf16().count() > 160)
        {
            return Err(fail(line, "Labels need 1–160 characters."));
        }
        // Hidden and locked use 0 or 1.
        for value in [&r_hidden, &r_locked] {
            match value {
                Val::Num(n) if *n == 0.0 || *n == 1.0 => {}
                _ => return Err(fail(line, "Hidden and locked use 0 or 1.")),
            }
        }
        // Scale, rotation, opacity ranges.
        let Val::Num(scale) = r_scale else {
            return Err(fail(
                line,
                "Scale: 0.1–4; rotation: -360–360 degrees; opacity: 0–1.",
            ));
        };
        let Val::Num(rotation) = r_rotation else {
            return Err(fail(
                line,
                "Scale: 0.1–4; rotation: -360–360 degrees; opacity: 0–1.",
            ));
        };
        let Val::Num(opacity) = r_opacity else {
            return Err(fail(
                line,
                "Scale: 0.1–4; rotation: -360–360 degrees; opacity: 0–1.",
            ));
        };
        if !scale.is_finite()
            || !(0.1..=4.0).contains(&scale)
            || !rotation.is_finite()
            || rotation.abs() > 360.0
            || !opacity.is_finite()
            || !(0.0..=1.0).contains(&opacity)
        {
            return Err(fail(
                line,
                "Scale: 0.1–4; rotation: -360–360 degrees; opacity: 0–1.",
            ));
        }
        // Position: two finite pixel coordinates (resolve each).
        if let Some(position) = &clip.position {
            for arg in position {
                let value = resolve(arg, &params, line)?;
                let Val::Num(n) = value else {
                    return Err(fail(line, "Position needs two finite pixel coordinates."));
                };
                if !n.is_finite() || n.abs() > 100000.0 {
                    return Err(fail(line, "Position needs two finite pixel coordinates."));
                }
            }
        }
        // Engine: clip.sourceDuration ??= clip.sourceAt + clip.for (only
        // when never set), then the source-window checks.
        let source_duration = r_source_duration.unwrap_or_else(|| js_plus(&r_source_at, &r_for));
        let Val::Num(source_at) = r_source_at else {
            return Err(fail(line, "Clip exceeds its animation source window."));
        };
        if !source_at.is_finite() || source_at < 0.0 {
            return Err(fail(line, "Clip exceeds its animation source window."));
        }
        let Val::Num(source_duration) = source_duration else {
            return Err(fail(line, "Clip exceeds its animation source window."));
        };
        let max_source_duration = if matches!(clip.kind, Kind::Video | Kind::Audio) {
            3600.0
        } else {
            60.0
        };
        if !source_duration.is_finite()
            || source_duration <= 0.0
            || source_duration > max_source_duration
        {
            return Err(fail(line, "Clip exceeds its animation source window."));
        }
        // Engine: clip.sourceAt + clip.for > clip.sourceDuration + 0.000001.
        // A non-numeric `for` fails at the at/for check below in the
        // engine (string > number is false there); both paths fail, so
        // failing here keeps the outcome identical.
        let Val::Num(for_value) = r_for else {
            return Err(fail(line, "Keep clip timing inside the composition."));
        };
        if source_at + for_value > source_duration + 0.000001 {
            return Err(fail(line, "Clip exceeds its animation source window."));
        }
        // Timing inside the composition.
        let Val::Num(at) = r_at else {
            return Err(fail(line, "Keep clip timing inside the composition."));
        };
        if !at.is_finite() || at < 0.0 {
            return Err(fail(line, "Keep clip timing inside the composition."));
        }
        if !for_value.is_finite() || for_value <= 0.0 || at + for_value > duration + 0.001 {
            return Err(fail(line, "Keep clip timing inside the composition."));
        }
        // Text values must be strings (all clip kinds).
        let Val::Str(_) = &r_value else {
            return Err(fail(line, "Text values must be strings."));
        };
        let Val::Str(place) = &r_place else {
            return Err(fail(
                line,
                "Place supports \"left\", \"center\", or \"bottom\".",
            ));
        };
        if !["left", "center", "bottom"].contains(&place.as_str()) {
            return Err(fail(
                line,
                "Place supports \"left\", \"center\", or \"bottom\".",
            ));
        }
        let Val::Str(motion) = &r_motion else {
            return Err(fail(
                line,
                "Motion supports \"rise\", \"fade\", \"orbit\", \"pulse\", or \"none\".",
            ));
        };
        if !["rise", "fade", "orbit", "pulse", "none"].contains(&motion.as_str()) {
            return Err(fail(
                line,
                "Motion supports \"rise\", \"fade\", \"orbit\", \"pulse\", or \"none\".",
            ));
        }
        let Val::Str(look) = &r_look else {
            return Err(fail(
                line,
                "Look supports \"orbit\", \"pulse\", or \"grid\".",
            ));
        };
        if !["orbit", "pulse", "grid"].contains(&look.as_str()) {
            return Err(fail(
                line,
                "Look supports \"orbit\", \"pulse\", or \"grid\".",
            ));
        }
        let Val::Str(color) = &r_color else {
            return Err(fail(line, "Colors use six-digit hex, such as \"#d6fa69\"."));
        };
        if !is_hex_color(color) {
            return Err(fail(line, "Colors use six-digit hex, such as \"#d6fa69\"."));
        }
        if matches!(clip.kind, Kind::Image | Kind::Video | Kind::Audio) {
            let kind = match clip.kind {
                Kind::Image => ClipKind::Image,
                Kind::Video => ClipKind::Video,
                _ => ClipKind::Audio,
            };
            let requirement = match clip.kind {
                Kind::Image => "Image clips require a source path.",
                Kind::Video => "Video clips require a source path.",
                _ => "Audio clips require a source path.",
            };
            let Val::Str(source_path) = &r_source else {
                return Err(fail(line, requirement));
            };
            if js_trim(source_path).is_empty() {
                return Err(fail(line, requirement));
            }
            if matches!(clip.kind, Kind::Image | Kind::Video) {
                let Val::Str(fit) = &r_fit else {
                    return Err(fail(
                        line,
                        "Fit supports \"contain\", \"cover\", or \"fill\".",
                    ));
                };
                if !["contain", "cover", "fill"].contains(&fit.as_str()) {
                    return Err(fail(
                        line,
                        "Fit supports \"contain\", \"cover\", or \"fill\".",
                    ));
                }
            }
            if clip.kind == Kind::Audio {
                let Val::Num(gain) = r_gain else {
                    return Err(fail(line, "Gain must be between 0 and 2."));
                };
                if !gain.is_finite() || !(0.0..=2.0).contains(&gain) {
                    return Err(fail(line, "Gain must be between 0 and 2."));
                }
            }
            sources.push(ClipSource {
                kind,
                path: source_path.clone(),
            });
        }
    }

    // Tempo, the engine's last parameter check.
    if let Some((value, line_index)) = params
        .get_key_value("tempo")
        .map(|(k, v)| (v, param_lines[k]))
    {
        let tempo_ok = matches!(value, Val::Num(t) if t.is_finite() && (0.2..=3.0).contains(t));
        if !tempo_ok {
            return Err(fail(line_index + 1, "Tempo must be between 0.2 and 3."));
        }
    }

    Ok(sources)
}

/// The image-only view of [`clip_sources`], kept for callers that still
/// want plain image paths (the existing Stage 4 tests and image relinking).
pub fn image_clip_sources(source: &str) -> Result<Vec<String>, String> {
    Ok(clip_sources(source)?
        .into_iter()
        .filter(|clip| clip.kind == ClipKind::Image)
        .map(|clip| clip.path)
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sources_of(source: &str) -> Vec<String> {
        image_clip_sources(source).unwrap()
    }

    fn err_of(source: &str) -> String {
        image_clip_sources(source).unwrap_err()
    }

    const PATH: &str = r"C:\Users\Me\pics\Hero.png";

    fn image_line(path: &str) -> String {
        // Paths reach the DSL the way the renderer writes them: JSON
        // string literals with escaped backslashes.
        format!(
            "composition(\"Scan\").duration(5)\nimage(\"hero\").at(0).for(5).source({})",
            serde_json::to_string(path).unwrap()
        )
    }

    #[test]
    fn extracts_video_and_audio_sources_with_their_kinds() {
        let video = r"C:\clips\b-roll.mp4";
        let audio = r"C:\audio\score.mp3";
        let source = format!(
            "composition(\"Media\").duration(20)\nvideo(\"V\").at(0).for(5).source({}).sourceDuration(30)\naudio(\"A\").at(5).for(5).source({}).gain(0.4)",
            serde_json::to_string(video).unwrap(),
            serde_json::to_string(audio).unwrap()
        );
        assert_eq!(
            clip_sources(&source).unwrap(),
            vec![
                ClipSource { kind: ClipKind::Video, path: video.to_string() },
                ClipSource { kind: ClipKind::Audio, path: audio.to_string() },
            ]
        );
        assert_eq!(
            image_clip_sources(&source).unwrap(),
            Vec::<String>::new(),
            "the image-only wrapper ignores media"
        );
    }

    #[test]
    fn media_acceptance_matches_the_engine_matrix() {
        let path_json = serde_json::to_string(r"C:\a.mp4").unwrap();
        // Media keeps the one-hour source cap; images stay at 60 s.
        let long = format!(
            "composition(\"L\").duration(10)\nvideo(\"v\").at(0).for(10).source({path_json}).sourceDuration(3600)"
        );
        assert_eq!(clip_sources(&long).unwrap().len(), 1);
        let too_long = format!(
            "composition(\"L\").duration(10)\nvideo(\"v\").at(0).for(10).source({path_json}).sourceDuration(3600.5)"
        );
        assert!(clip_sources(&too_long)
            .unwrap_err()
            .contains("Clip exceeds its animation source window."));
        // Audio has no visual surface: opacity/scale/rotation/position/fit
        // are all rejected, like the engine.
        for method in ["opacity(0.5)", "scale(2)", "rotation(15)", "position(1, 2)", "fit(\"cover\")"] {
            let source = format!(
                "composition(\"A\").duration(10)\naudio(\"a\").at(0).for(5).source(\"C:\\\\a.mp3\").{method}"
            );
            assert!(
                clip_sources(&source)
                    .unwrap_err()
                    .contains("Unsupported or repeated method"),
                "audio {method}"
            );
        }
        // Video rejects audio-only gain.
        let video_gain = format!(
            "composition(\"V\").duration(10)\nvideo(\"v\").at(0).for(5).source({path_json}).gain(1)"
        );
        assert!(clip_sources(&video_gain)
            .unwrap_err()
            .contains("Unsupported or repeated method: .gain()."));
        // Gain range and required sources.
        for gain in ["-1", "3", "\"loud\""] {
            let source = format!(
                "composition(\"A\").duration(10)\naudio(\"a\").at(0).for(5).source(\"C:\\\\a.mp3\").gain({gain})"
            );
            assert!(
                clip_sources(&source)
                    .unwrap_err()
                    .contains("Gain must be between 0 and 2."),
                "gain {gain}"
            );
        }
        assert!(clip_sources("composition(\"A\").duration(10)\nvideo(\"v\").at(0).for(5)")
            .unwrap_err()
            .contains("Video clips require a source path."));
        assert!(clip_sources("composition(\"A\").duration(10)\naudio(\"a\").at(0).for(5)")
            .unwrap_err()
            .contains("Audio clips require a source path."));
    }

    #[test]
    fn media_always_has_a_source_window() {
        // No explicit sourceAt/sourceDuration: the default window is
        // sourceAt + for, and hasSourceWindow is not part of the scan
        // output, so this pins that the default compiles and resolves.
        let source = format!(
            "composition(\"M\").duration(10)\nvideo(\"v\").at(1).for(4).source({})",
            serde_json::to_string(PATH).unwrap()
        );
        assert_eq!(
            clip_sources(&source).unwrap(),
            vec![ClipSource {
                kind: ClipKind::Video,
                path: PATH.to_string()
            }]
        );
    }

    #[test]
    fn extracts_image_clip_sources_from_valid_compositions() {
        assert_eq!(sources_of(&image_line(PATH)), vec![PATH.to_string()]);
        // Multiple image clips, in clip order.
        let source = format!(
            "composition(\"Two\").duration(9)\nimage(\"a\").at(0).for(3).source({})\nimage(\"b\").at(3).for(3).source({})",
            serde_json::to_string(r"C:\a\One.png").unwrap(),
            serde_json::to_string(r"C:\b\Two.png").unwrap()
        );
        assert_eq!(
            sources_of(&source),
            vec![r"C:\a\One.png".to_string(), r"C:\b\Two.png".to_string()]
        );
        // Non-image clips contribute nothing even when their strings look
        // like paths, and `source()` on a non-image clip is a parse error.
        let source = format!(
            "composition(\"Mixed\").duration(5)\ntext(\"t\").at(0).for(5).value({})\nimage(\"i\").at(0).for(5).source({})",
            serde_json::to_string(r"C:\not\an\image.png").unwrap(),
            serde_json::to_string(PATH).unwrap()
        );
        assert_eq!(sources_of(&source), vec![PATH.to_string()]);
    }

    #[test]
    fn resolves_parameter_references_like_the_engine() {
        // Forward references are allowed: params resolve after all lines.
        let source = format!(
            "composition(\"Params\").duration(5)\nimage(\"hero\").at(0).for(5).source($imagePath)\nparam(\"imagePath\", {})",
            serde_json::to_string(PATH).unwrap()
        );
        assert_eq!(sources_of(&source), vec![PATH.to_string()]);
        // A numeric parameter is not a valid image source.
        let source = "composition(\"Params\").duration(5)\nparam(\"imagePath\", 3)\nimage(\"hero\").at(0).for(5).source($imagePath)";
        assert!(err_of(source).contains("Image clips require a source path."));
        // An unknown parameter fails the whole compile.
        let source =
            "composition(\"Params\").duration(5)\nimage(\"hero\").at(0).for(5).source($nope)";
        assert!(err_of(source).contains("Unknown parameter: $nope."));
    }

    #[test]
    fn json_escapes_and_unicode_decode_like_json_parse() {
        // The DSL carries a literal \u00e9 escape sequence (backslash,
        // u, 00e9), which JSON.parse decodes to é.
        let source = "composition(\"Esc\").duration(5)\nimage(\"hero\").at(0).for(5).source(\"C:\\\\caf\\u00e9\\\\a b.png\")";
        assert_eq!(sources_of(source), vec![r"C:\café\a b.png".to_string()]);
        // A single-backslash Windows path is invalid JSON, exactly like
        // the engine (JSON.parse throws on the bad escape).
        let source = "composition(\"Esc\").duration(5)\nimage(\"hero\").at(0).for(5).source(\"C:\\Users\\a.png\")";
        assert!(err_of(source).contains("Use a quoted string"));
    }

    #[test]
    fn comments_and_blank_lines_are_skipped() {
        let source = format!(
            "// image(\"ghost\").at(0).for(5).source({})\n\ncomposition(\"Scan\").duration(5)\nimage(\"hero\").at(0).for(5).source({})",
            serde_json::to_string(r"C:\ghost.png").unwrap(),
            serde_json::to_string(PATH).unwrap()
        );
        assert_eq!(sources_of(&source), vec![PATH.to_string()]);
    }

    #[test]
    fn invalid_sources_fail_closed_like_the_engine() {
        let path_json = serde_json::to_string(PATH).unwrap();
        let cases: Vec<(String, &str)> = vec![
            // No composition.
            (format!("image(\"hero\").at(0).for(5).source({path_json})"), "Start with composition"),
            // Unknown function. `video`/`audio` are valid since Stage 6;
            // an unknown root keeps the legacy error contract.
            (format!("composition(\"Bad\").duration(5)\ncamera(\"v\").at(0).for(5).source({path_json})"), "Unknown function: camera."),
            // Trailing comment after a call is invalid DSL (the engine's
            // calls() parser hits it and fails).
            (format!("composition(\"Bad\").duration(5)\nimage(\"hero\").at(0).for(5).source({path_json}) // note"), "Expected a function call"),
            // Source on a non-image clip is unsupported.
            (format!("composition(\"Bad\").duration(5)\nscene(\"s\").at(0).for(5).source({path_json})"), "Unsupported or repeated method: .source()."),
            // Image clip without a source.
            ("composition(\"Bad\").duration(5)\nimage(\"hero\").at(0).for(5)".to_string(), "Image clips require a source path."),
            // Repeated method.
            (format!("composition(\"Bad\").duration(5)\nimage(\"hero\").at(0).at(1).source({path_json})"), "Unsupported or repeated method: .at()."),
            // Wrong argument count.
            (format!("composition(\"Bad\").duration(5)\nimage(\"hero\").at(0).for(5).source({path_json}, {path_json})"), "Unsupported or repeated method: .source()."),
            // Unterminated string: the engine's parenthesis scan reaches
            // end-of-input first and reports the paren error.
            ("composition(\"Bad\").duration(5)\nimage(\"hero\").at(0).for(5).source(\"C:\\\\a.png".to_string(), "Close the function with a parenthesis."),
            // Unclosed function.
            (format!("composition(\"Bad\").duration(5)\nimage(\"hero\").at(0).for(5).source({path_json}"), "Close the function with a parenthesis."),
            // Chain without a dot.
            (format!("composition(\"Bad\").duration(5)\nimage(\"hero\").at(0).for(5) .source({path_json})"), "Expected a function call"),
            // Non-numeric duration argument.
            ("composition(\"Bad\").duration(\"5\")".to_string(), "Composition supports .duration(seconds)."),
            // Duration out of range.
            ("composition(\"Bad\").duration(61)".to_string(), "Duration must be between 1 and 60 seconds."),
            // Timing outside the composition.
            (format!("composition(\"Bad\").duration(5)\nimage(\"hero\").at(10).for(5).source({path_json})"), "Keep clip timing inside the composition."),
            // Unresolvable chain method.
            (format!("composition(\"Bad\").duration(5)\nimage(\"hero\").at(0).for(5).wobble({path_json})"), "Unsupported or repeated method: .wobble()."),
            // param with a $reference value (an object, like the engine).
            (format!("composition(\"Bad\").duration(5)\nparam(\"a\", $b)\nimage(\"hero\").at(0).for(5).source({path_json})"), "Use param("),
            // Duplicate parameter names.
            (format!("composition(\"Bad\").duration(5)\nparam(\"a\", \"1\")\nparam(\"a\", \"2\")\nimage(\"hero\").at(0).for(5).source({path_json})"), "Parameter names must be unique."),
            // Duplicate clip names.
            (format!("composition(\"Bad\").duration(5)\nimage(\"hero\").at(0).for(5).source({path_json})\nimage(\"hero\").at(0).for(5).source({path_json})"), "Clip names must be unique."),
            // Tempo out of range.
            (format!("composition(\"Bad\").duration(5)\nparam(\"tempo\", 9)\nimage(\"hero\").at(0).for(5).source({path_json})"), "Tempo must be between 0.2 and 3."),
            // Unsupported color.
            (format!("composition(\"Bad\").duration(5)\nshape(\"s\").at(0).for(5).color(\"red\")\nimage(\"hero\").at(0).for(5).source({path_json})"), "Colors use six-digit hex"),
            // Out-of-window source timing: an explicit source window
            // shorter than at + for.
            (format!("composition(\"Bad\").duration(12)\nimage(\"hero\").at(0).for(12).sourceAt(10).sourceDuration(5).source({path_json})"), "Clip exceeds its animation source window."),
        ];
        for (source, expected) in cases {
            let error = err_of(&source);
            assert!(
                error.contains(expected),
                "source: {source}\nerror: {error}\nexpected: {expected}"
            );
        }
        // More than 24 clips fails.
        let mut many = String::from("composition(\"Bad\").duration(60)\n");
        for i in 0..25 {
            many.push_str(&format!(
                "image(\"c{i}\").at(0).for(1).source({})\n",
                serde_json::to_string(PATH).unwrap()
            ));
        }
        assert!(err_of(&many).contains("up to 24 clips"));
    }

    #[test]
    fn default_source_and_helpers_still_compile() {
        // The real default template compiles and has no images.
        let default_source = concat!(
            "// A composition is a small, reusable score.\n",
            "composition(\"Orbit study\").duration(12)\n\n",
            "// These become editable template controls.\n",
            "param(\"title\", \"MAKE IT MOVE.\")\n",
            "param(\"subtitle\", \"A small idea. In motion.\")\n",
            "param(\"accent\", \"#d6fa69\")\n",
            "param(\"tempo\", 1)\n\n",
            "scene(\"Backdrop\").at(0).for(12).look(\"orbit\")\n",
            "text(\"Headline\").at(0.4).for(10.8).value($title).place(\"left\").motion(\"rise\")\n",
            "text(\"Caption\").at(1).for(10).value($subtitle).place(\"bottom\").motion(\"fade\")\n",
            "shape(\"Signal\").at(0).for(12).color($accent).motion(\"orbit\")"
        );
        assert!(sources_of(default_source).is_empty());
    }

    #[test]
    fn js_trim_parity_covers_feff_and_unicode_whitespace() {
        // U+FEFF is JS `trim()` whitespace but not Rust White_Space: the
        // engine trims it away, so the port must too or it diverges.
        let source = "composition(\"Trim\").duration(5)\nimage(\"a\").at(\u{feff}0).for(5).source(\"C:\\\\a.png\")";
        assert_eq!(sources_of(source), vec![r"C:\a.png".to_string()]);
        // U+0085 is Rust whitespace but not JS whitespace: neither side
        // may trim it, so the padded number stays invalid JSON.
        let source = "composition(\"Trim\").duration(5)\nimage(\"a\").at(\u{0085}0).for(5).source(\"C:\\\\a.png\")";
        assert!(err_of(source).contains("Use a quoted string"));
        // A label that is only U+FEFF trims to nothing: rejected.
        let source = "composition(\"Trim\").duration(5)\nimage(\"a\").at(0).for(5).label(\"\u{feff}\").source(\"C:\\\\a.png\")";
        let error = err_of(source);
        assert!(
            error.contains("Labels need 1–160 characters."),
            "unexpected error: {error}"
        );
        // A source path that is only whitespace trims to nothing: rejected.
        let source =
            "composition(\"Trim\").duration(5)\nimage(\"a\").at(0).for(5).source(\" \u{feff}\")";
        assert!(err_of(source).contains("Image clips require a source path."));
    }

    #[test]
    fn boolean_and_null_arguments_fail_like_json_parse() {
        // JSON.parse accepts true/null, but the engine's parseArg only
        // keeps strings and numbers: both fail with the same message.
        let path_json = serde_json::to_string(PATH).unwrap();
        for arg in ["true", "null", "false"] {
            let source = format!(
                "composition(\"B\").duration(5)\nimage(\"h\").at(0).for(5).hidden({arg}).source({path_json})"
            );
            assert!(
                err_of(&source).contains("Use a quoted string"),
                "argument {arg}"
            );
        }
    }

    #[test]
    fn repeated_duration_uses_the_last_value_like_the_engine() {
        let path_json = serde_json::to_string(PATH).unwrap();
        // The last .duration() wins: at(50).for(5) fits 60 but not 5.
        let source = format!(
            "composition(\"D\").duration(5).duration(60)\nimage(\"h\").at(50).for(5).source({path_json})"
        );
        assert_eq!(sources_of(&source), vec![PATH.to_string()]);
        let source = format!(
            "composition(\"D\").duration(60).duration(5)\nimage(\"h\").at(50).for(5).source({path_json})"
        );
        assert!(err_of(&source).contains("Keep clip timing inside the composition."));
    }

    #[test]
    fn string_for_with_explicit_source_duration_fails_at_the_timing_check() {
        // The engine: sourceDuration is explicit (5, a number), the
        // source-window comparison coerces `0 + "abc"` to "0abc" and
        // passes, and the finite-for check rejects it afterwards.
        let path_json = serde_json::to_string(PATH).unwrap();
        let source = format!(
            "composition(\"C\").duration(5)\nimage(\"h\").at(0).for(\"abc\").sourceDuration(5).source({path_json})"
        );
        assert!(err_of(&source).contains("Keep clip timing inside the composition."));
        // With no explicit sourceDuration, `??=` builds the string sum and
        // the source-window check rejects it first, like the engine.
        let source = format!(
            "composition(\"C\").duration(5)\nimage(\"h\").at(0).for(\"abc\").source({path_json})"
        );
        assert!(err_of(&source).contains("Clip exceeds its animation source window."));
    }

    #[test]
    fn label_length_is_only_checked_when_it_differs_from_the_id() {
        // The default label IS the id: no length cap, exactly like the
        // engine's `clip.label !== clip.id` guard.
        let long_id = "x".repeat(200);
        let source = format!(
            "composition(\"L\").duration(5)\nimage({}).at(0).for(5).source({})",
            serde_json::to_string(&long_id).unwrap(),
            serde_json::to_string(PATH).unwrap()
        );
        assert_eq!(sources_of(&source), vec![PATH.to_string()]);
        // A different label of exactly 160 UTF-16 units is allowed…
        let at_cap = "y".repeat(160);
        let source = format!(
            "composition(\"L\").duration(5)\nimage(\"a\").at(0).for(5).label({}).source({})",
            serde_json::to_string(&at_cap).unwrap(),
            serde_json::to_string(PATH).unwrap()
        );
        assert_eq!(sources_of(&source), vec![PATH.to_string()]);
        // …161 units fails, and multi-byte characters count as their
        // UTF-16 length (é is one unit), not their UTF-8 bytes: 81 of
        // them are 162 UTF-8 bytes but only 81 UTF-16 units, so they pass.
        let byte_over_unit_under = "é".repeat(81);
        let source = format!(
            "composition(\"L\").duration(5)\nimage(\"a\").at(0).for(5).label({}).source({})",
            serde_json::to_string(&byte_over_unit_under).unwrap(),
            serde_json::to_string(PATH).unwrap()
        );
        assert_eq!(
            sources_of(&source),
            vec![PATH.to_string()],
            "length counts UTF-16 units, not UTF-8 bytes"
        );
        let over_cap = "é".repeat(161);
        let source = format!(
            "composition(\"L\").duration(5)\nimage(\"a\").at(0).for(5).label({}).source({})",
            serde_json::to_string(&over_cap).unwrap(),
            serde_json::to_string(PATH).unwrap()
        );
        assert!(err_of(&source).contains("Labels need 1–160 characters."));
    }

    #[test]
    fn scene_rejects_scale_and_rotation_like_the_engine() {
        // scale/rotation are image-clip extras; the engine's allowed list
        // for scene excludes them.
        let path_json = serde_json::to_string(PATH).unwrap();
        for method in ["scale(2)", "rotation(90)"] {
            let source = format!(
                "composition(\"S\").duration(5)\nscene(\"s\").at(0).for(5).{method}\nimage(\"h\").at(0).for(5).source({path_json})"
            );
            let error = err_of(&source);
            assert!(
                error.contains("Unsupported or repeated method"),
                "method {method}: {error}"
            );
        }
    }

    #[test]
    fn out_of_range_floats_fail_closed() {
        // JS: JSON.parse("1e999") is Infinity, a typeof-"number" value, so
        // the duration range check rejects it. serde_json rejects the
        // literal at parse time instead — a different message for the same
        // fail-closed outcome (scanning contributes nothing either way).
        let error = err_of("composition(\"F\").duration(1e999)");
        assert!(
            error.contains("Duration must be between") || error.contains("Use a quoted string"),
            "unexpected error: {error}"
        );
    }
}
