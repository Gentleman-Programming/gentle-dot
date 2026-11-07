//! Read-only UIAutomation facts normalized to the existing risk classifier.
//! Never request Value/Text patterns or read password values. Every interface and COM
//! apartment is created, used and released on the current thread.
use std::{marker::PhantomData, rc::Rc, time::{Duration, Instant}};
use windows::{core::{BSTR, HRESULT, Interface}, Win32::{Foundation::{HWND, VARIANT_FALSE, VARIANT_TRUE}, System::{
    Com::{CoCreateInstance, CoInitializeEx, CoUninitialize, SAFEARRAY, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED},
    Ole::{SafeArrayDestroy, SafeArrayGetDim, SafeArrayGetElement, SafeArrayGetElemsize,
        SafeArrayGetLBound, SafeArrayGetUBound, SafeArrayGetVartype},
    Variant::{VariantClear, VARIANT, VT_BOOL, VT_I4}},
    UI::{Accessibility::*, WindowsAndMessaging::{STATE_SYSTEM_DEFAULT, STATE_SYSTEM_PROTECTED}}}};
use super::{context::{error, point, Dpi, PixelRect}, identity,
    super::{blocklist::AppIdentity, coords::Point, risk::{AxElement, Focus}}};

const PROVIDER_TIMEOUT_MS: u32 = 100;
const QUERY_BUDGET: Duration = Duration::from_millis(500);
#[path = "ancestry.rs"]
mod ancestry;
const MAX_DEFAULT_CANDIDATES: usize = 64;
const MAX_RUNTIME_ID: usize = 64;

struct Apartment(PhantomData<Rc<()>>);
impl Apartment {
    fn enter() -> Result<Self, String> {
        // SAFETY: balanced even on S_FALSE; an incompatible pre-existing apartment
        // returns an error, never an unbalanced CoUninitialize or cross-thread handoff.
        unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.ok()
            .map_err(|e| error("COM apartment", e))?;
        Ok(Self(PhantomData))
    }
}
impl Drop for Apartment {
    fn drop(&mut self) { unsafe { CoUninitialize() }; }
}

pub(super) struct Automation {
    // Declaration order is significant: release the interface before the apartment.
    api: IUIAutomation2,
    _apartment: Apartment,
    started: Instant,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct PointFacts {
    pub at: (i32, i32),
    pub window: usize,
    pub app: AppIdentity,
    pub chain: Vec<AxElement>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct FocusFacts {
    pub window: usize,
    pub app: AppIdentity,
    pub focus: Focus,
    pub default_known: bool,
    pub default_failure: Option<DefaultFailure>,
    pub frame: Option<PixelRect>,
    // Only full keyboard observations acquire this. Capture targets keep None.
    pub runtime_id: Option<Vec<i32>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum DefaultFailure { NotRequested, Query, Candidates, Legacy, Ancestry, Ambiguous, Budget }
impl DefaultFailure {
    pub(super) fn reason(self) -> &'static str {
        match self {
            Self::NotRequested => "default_unknown_unrequested",
            Self::Query => "default_unknown_query",
            Self::Candidates => "default_unknown_candidates",
            Self::Legacy => "default_unknown_legacy",
            Self::Ancestry => "default_unknown_ancestry",
            Self::Ambiguous => "default_unknown_ambiguous",
            Self::Budget => "default_unknown_budget",
        }
    }
}

// A successful nullable COM result is known absence, not a failed query.
// Even S_FALSE is not promoted to complete enumeration. Owned results drop on error.
fn complete_default_query<T>(status: HRESULT, result: Option<T>) -> Result<Option<T>, DefaultFailure> {
    if status.0 != 0 { return Err(DefaultFailure::Query); }
    Ok(result)
}

// Inspect metadata for every matching candidate before exposing any default label.
fn unique_default<T>(count: i32, mut inspect: impl FnMut(i32) -> Result<Option<T>, DefaultFailure>)
    -> Result<Option<T>, DefaultFailure> {
    if count < 0 || count as usize > MAX_DEFAULT_CANDIDATES { return Err(DefaultFailure::Candidates); }
    let mut selected = None;
    for index in 0..count {
        if let Some(candidate) = inspect(index)? {
            if selected.is_some() { return Err(DefaultFailure::Ambiguous); }
            selected = Some(candidate);
        }
    }
    Ok(selected)
}

pub(super) fn valid_runtime_id(id: &[i32]) -> bool {
    !id.is_empty() && id.len() <= MAX_RUNTIME_ID
}

// Single-owner, current-thread allocation returned by UIA (or native test fixtures).
struct RuntimeIdArray(*mut SAFEARRAY);
impl RuntimeIdArray {
    fn close(&mut self) -> Result<(), String> {
        if self.0.is_null() { return Ok(()); }
        // SAFETY: this owner exclusively holds the returned SAFEARRAY.
        unsafe { SafeArrayDestroy(self.0) }.map_err(|e| error("UIA runtime identity cleanup", e))?;
        self.0 = std::ptr::null_mut();
        Ok(())
    }
}
impl Drop for RuntimeIdArray {
    fn drop(&mut self) {
        // Error/unwind fallback only; successful checked cleanup disarms ownership.
        if !self.0.is_null() { let _ = unsafe { SafeArrayDestroy(self.0) }; }
    }
}

fn runtime_id_from_array(mut array: RuntimeIdArray) -> Result<Vec<i32>, String> {
    let result = (|| {
        if array.0.is_null() { return Err("UIA runtime identity missing".into()); }
        // SAFETY: UIA supplies a live native allocation; metadata is checked before
        // supplying i32 storage. No arbitrary pointer or array descriptor is forged.
        if unsafe { SafeArrayGetDim(array.0) } != 1
            || unsafe { SafeArrayGetVartype(array.0) }.map_err(|e| error("UIA identity type", e))? != VT_I4
            || unsafe { SafeArrayGetElemsize(array.0) } as usize != std::mem::size_of::<i32>() {
            return Err("unsupported UIA runtime identity layout".into());
        }
        let lower = unsafe { SafeArrayGetLBound(array.0, 1) }.map_err(|e| error("UIA identity lower bound", e))?;
        let upper = unsafe { SafeArrayGetUBound(array.0, 1) }.map_err(|e| error("UIA identity upper bound", e))?;
        let length = i64::from(upper) - i64::from(lower) + 1;
        if !(1..=MAX_RUNTIME_ID as i64).contains(&length) {
            return Err("UIA runtime identity length is invalid".into());
        }
        let mut values = Vec::new();
        values.try_reserve_exact(length as usize).map_err(|_| "UIA identity allocation unavailable")?;
        for offset in 0..length {
            let index = (i64::from(lower) + offset) as i32; // within validated i32 bounds
            let mut value = 0i32;
            unsafe { SafeArrayGetElement(array.0, &index, (&mut value as *mut i32).cast()) }
                .map_err(|e| error("UIA identity element", e))?;
            values.push(value);
        }
        Ok(values)
    })();
    // Never admit an identity whose owned native storage could not be released.
    array.close()?;
    result
}

fn bounded_label(text: BSTR) -> Result<Option<String>, String> {
    if text.len() > 2048 { return Err("accessibility label exceeds limit".into()); }
    let text = text.to_string();
    Ok((!text.trim().is_empty()).then_some(text))
}

/// Unknown/custom provider controls are refused, not disguised as empty facts.
fn role(kind: UIA_CONTROLTYPE_ID) -> Result<&'static str, String> {
    use windows::Win32::UI::Accessibility::{
        UIA_ButtonControlTypeId as BUTTON,
        UIA_CheckBoxControlTypeId as CHECK_BOX,
        UIA_RadioButtonControlTypeId as RADIO_BUTTON,
        UIA_TabItemControlTypeId as TAB_ITEM,
        UIA_SplitButtonControlTypeId as SPLIT_BUTTON,
        UIA_MenuItemControlTypeId as MENU_ITEM,
        UIA_HyperlinkControlTypeId as HYPERLINK,
        UIA_EditControlTypeId as EDIT,
        UIA_DocumentControlTypeId as DOCUMENT,
        UIA_ComboBoxControlTypeId as COMBO_BOX,
        UIA_TextControlTypeId as TEXT,
        UIA_MenuBarControlTypeId as MENU_BAR,
        UIA_MenuControlTypeId as MENU,
        UIA_WindowControlTypeId as WINDOW,
        UIA_PaneControlTypeId as PANE,
        UIA_GroupControlTypeId as GROUP,
        UIA_ListControlTypeId as LIST,
        UIA_ListItemControlTypeId as LIST_ITEM,
        UIA_TabControlTypeId as TAB,
        UIA_ToolBarControlTypeId as TOOL_BAR,
        UIA_DataGridControlTypeId as DATA_GRID,
        UIA_DataItemControlTypeId as DATA_ITEM,
        UIA_TableControlTypeId as TABLE,
        UIA_TreeControlTypeId as TREE,
        UIA_TreeItemControlTypeId as TREE_ITEM,
        UIA_ScrollBarControlTypeId as SCROLL_BAR,
        UIA_SliderControlTypeId as SLIDER,
        UIA_ImageControlTypeId as IMAGE,
    };
    Ok(match kind {
        BUTTON | CHECK_BOX | RADIO_BUTTON
            | TAB_ITEM => "AXButton",
        SPLIT_BUTTON => "AXMenuButton",
        MENU_ITEM => "AXMenuItem",
        HYPERLINK => "AXLink",
        EDIT => "AXTextField",
        DOCUMENT => "AXTextArea",
        COMBO_BOX => "AXComboBox",
        TEXT => "AXStaticText",
        MENU_BAR => "AXMenuBar",
        MENU => "AXMenu",
        WINDOW => "AXWindow",
        PANE | GROUP | LIST
            | LIST_ITEM | TAB | TOOL_BAR
            | DATA_GRID | DATA_ITEM | TABLE
            | TREE | TREE_ITEM => "AXGroup",
        SCROLL_BAR => "AXScrollBar",
        SLIDER => "AXSlider",
        IMAGE => "AXImage",
        _ => return Err("unsupported accessibility control type".into()),
    })
}

/// Only a positively read absence skips legacy state. Provider/pattern/state errors
/// must stop validation before any accessibility label or observation is recorded.
fn validate_legacy_protection(available: Result<bool, String>,
    state: impl FnOnce() -> Result<u32, String>) -> Result<(), String> {
    if available? && state()? & STATE_SYSTEM_PROTECTED != 0 {
        return Err("protected accessibility target".into());
    }
    Ok(())
}

impl Automation {
    fn legacy_pattern_available(element: &IUIAutomationElement) -> Result<bool, String> {
        // This is a fixed capability property, never a control's Value/Text data.
        // Ignore defaults: missing/unknown/type-invalid metadata is not absence.
        let mut value = unsafe { element.GetCurrentPropertyValueEx(
            UIA_IsLegacyIAccessiblePatternAvailablePropertyId, true) }
            .map_err(|e| error("UIA legacy availability", e))?;
        // SAFETY: inspect the discriminant before accessing the Boolean union arm.
        let available = unsafe {
            let fields = &value.Anonymous.Anonymous;
            if fields.vt != VT_BOOL {
                Err("UIA legacy availability is not a Boolean".into())
            } else {
                match fields.Anonymous.boolVal {
                    VARIANT_FALSE => Ok(false),
                    VARIANT_TRUE => Ok(true),
                    _ => Err("UIA legacy availability has an invalid Boolean".into()),
                }
            }
        };
        // Also clear unexpected types (including owned interface/string variants).
        unsafe { VariantClear(&mut value) }.map_err(|e| error("UIA availability cleanup", e))?;
        available
    }

    pub fn new() -> Result<Self, String> {
        let apartment = Apartment::enter()?;
        let api: IUIAutomation2 = unsafe { CoCreateInstance(&CUIAutomation8, None, CLSCTX_INPROC_SERVER) }
            .map_err(|e| error("UIAutomation creation", e))?;
        unsafe {
            api.SetConnectionTimeout(PROVIDER_TIMEOUT_MS).map_err(|e| error("UIA connection timeout", e))?;
            api.SetTransactionTimeout(PROVIDER_TIMEOUT_MS).map_err(|e| error("UIA transaction timeout", e))?;
            api.SetAutoSetFocus(false).map_err(|e| error("UIA read-only focus setup", e))?;
        }
        Ok(Self { api, _apartment: apartment, started: Instant::now() })
    }

    fn runtime_id(&self, element: &IUIAutomationElement) -> Result<Vec<i32>, String> {
        self.budget()?;
        let raw = unsafe { element.GetRuntimeId() }.map_err(|e| error("UIA runtime identity", e))?;
        runtime_id_from_array(RuntimeIdArray(raw))
    }

    fn budget(&self) -> Result<(), String> {
        if self.started.elapsed() > QUERY_BUDGET { return Err("accessibility query budget exceeded".into()); }
        Ok(())
    }

    fn validate_element(&self, element: &IUIAutomationElement, pid: i32) -> Result<(), String> {
        self.budget()?;
        // SAFETY: read-only COM property calls on this apartment. Password is checked
        // BEFORE any name/help text; values and Text/Value patterns are never read.
        unsafe {
            if element.CurrentProcessId().map_err(|e| error("UIA owner", e))? != pid
                || element.CurrentIsPassword().map_err(|e| error("UIA password status", e))?.as_bool()
                || !element.CurrentIsEnabled().map_err(|e| error("UIA enabled status", e))?.as_bool()
                || element.CurrentIsOffscreen().map_err(|e| error("UIA visibility", e))?.as_bool() {
                return Err("protected, disabled, offscreen or differently-owned accessibility target".into());
            }
            validate_legacy_protection(Self::legacy_pattern_available(element), || {
                let legacy = element.GetCurrentPatternAs::<IUIAutomationLegacyIAccessiblePattern>(UIA_LegacyIAccessiblePatternId)
                    .map_err(|e| error("UIA legacy pattern", e))?;
                legacy.CurrentState().map_err(|e| error("UIA protected state", e))
            })?;
        }
        Ok(())
    }

    fn describe(&self, element: &IUIAutomationElement, pid: i32) -> Result<AxElement, String> {
        self.validate_element(element, pid)?;
        let kind = unsafe { element.CurrentControlType() }.map_err(|e| error("UIA role", e))?;
        let role = role(kind)?.into();
        let title = bounded_label(unsafe { element.CurrentName() }.map_err(|e| error("UIA name", e))?)?;
        let description = bounded_label(unsafe { element.CurrentHelpText() }.map_err(|e| error("UIA help", e))?)?;
        Ok(AxElement { role, title, description, value: None })
    }

    fn chain(&self, element: IUIAutomationElement, window: HWND, pid: i32) -> Result<Vec<AxElement>, String> {
        self.budget()?;
        let root = unsafe { self.api.ElementFromHandle(window) }.map_err(|e| error("UIA window root", e))?;
        let walker = unsafe { self.api.RawViewWalker() }.map_err(|e| error("UIA parent walker", e))?;
        let elements = ancestry::walk(element, &root,
            |node| {
                self.validate_element(node, pid)?;
                // Role validation belongs to the protected ancestry admission,
                // not unrelated default-search container traversal.
                role(unsafe { node.CurrentControlType() }.map_err(|e| error("UIA role", e))?)?;
                Ok(())
            },
            |node| unsafe { walker.GetParentElement(node) }.map_err(|e| error("UIA ancestor", e)),
            |a, b| unsafe { self.api.CompareElements(a, b) }
                .map(|same| same.as_bool()).map_err(|e| error("UIA ancestry comparison", e)),
            || self.budget())?;
        // Every raw ancestor, including the exact HWND root, has passed all
        // protection/owner/role checks before ANY leaf or ancestor label is read.
        let mut facts = Vec::new();
        facts.try_reserve_exact(elements.len()).map_err(|_| "accessibility ancestry resource limit")?;
        for node in &elements { facts.push(self.describe(node, pid)?); }
        self.budget()?;
        Ok(facts)
    }

    pub fn point(&self, at: Point) -> Result<PointFacts, String> {
        self.budget()?;
        let window = identity::window_at(at)?;
        let app = identity::identity(window)?;
        let element = unsafe { self.api.ElementFromPoint(point(at)?) }.map_err(|e| error("UIA point target", e))?;
        self.validate_element(&element, app.pid)?;
        let bounds = PixelRect::from_rect(unsafe { element.CurrentBoundingRectangle() }
            .map_err(|e| error("UIA point bounds", e))?)?;
        if !bounds.contains(point(at)?) { return Err("accessibility point target has inconsistent physical bounds".into()); }
        let chain = self.chain(element, window, app.pid)?;
        if identity::window_at(at)? != window || identity::identity(window)? != app {
            return Err("pointer window changed during accessibility query".into());
        }
        let at = point(at)?;
        self.budget()?;
        Ok(PointFacts { at: (at.x, at.y), window: window.0 as usize, app, chain })
    }

    fn default_candidates(&self, root: &IUIAutomationElement)
        -> Result<Option<IUIAutomationElementArray>, DefaultFailure> {
        self.budget().map_err(|_| DefaultFailure::Budget)?;
        let condition = |kind: UIA_CONTROLTYPE_ID| {
            let mut value = VARIANT::default();
            // SAFETY: zeroed VT_I4 contains only a scalar, never owned pointers.
            unsafe {
                // Explicit dereference is required for a ManuallyDrop union arm.
                let fields = &mut *value.Anonymous.Anonymous;
                fields.vt = VT_I4;
                fields.Anonymous.lVal = kind.0;
                self.api.CreatePropertyCondition(UIA_ControlTypePropertyId, &value)
            }.map_err(|_| DefaultFailure::Query)
        };
        let buttons = condition(UIA_ButtonControlTypeId)?;
        let split = condition(UIA_SplitButtonControlTypeId)?;
        let any = unsafe { self.api.CreateOrCondition(&buttons, &split) }.map_err(|_| DefaultFailure::Query)?;
        let cache = unsafe { self.api.CreateCacheRequest() }.map_err(|_| DefaultFailure::Query)?;
        unsafe {
            cache.SetTreeFilter(&self.api.RawViewCondition().map_err(|_| DefaultFailure::Query)?)
                .map_err(|_| DefaultFailure::Query)?;
            cache.SetTreeScope(TreeScope_Element).map_err(|_| DefaultFailure::Query)?;
            cache.SetAutomationElementMode(AutomationElementMode_Full).map_err(|_| DefaultFailure::Query)?;
        }
        self.budget().map_err(|_| DefaultFailure::Budget)?;
        let mut raw = std::ptr::null_mut();
        // SAFETY: live current-apartment interfaces; OS writes one owned nullable
        // interface. Unlike the generated nonnullable wrapper, preserve S_OK+NULL
        // (documented no matches) separately from genuine HRESULT errors.
        let status = unsafe { (Interface::vtable(root).FindAllBuildCache)(
            Interface::as_raw(root), TreeScope_Subtree, Interface::as_raw(&any),
            Interface::as_raw(&cache), &mut raw) };
        let result = if raw.is_null() { None }
            else { Some(unsafe { IUIAutomationElementArray::from_raw(raw) }) };
        let result = complete_default_query(status, result)?; // releases owned output on error
        self.budget().map_err(|_| DefaultFailure::Budget)?;
        Ok(result)
    }

    // Metadata only: no names/help/values, and no assumption that an unrelated
    // disabled/offscreen non-default button invalidates the focused field.
    fn default_state(&self, element: &IUIAutomationElement, pid: i32) -> Result<u32, DefaultFailure> {
        self.budget().map_err(|_| DefaultFailure::Budget)?;
        unsafe {
            if element.CurrentProcessId().map_err(|_| DefaultFailure::Ancestry)? != pid
                || element.CurrentIsPassword().map_err(|_| DefaultFailure::Ancestry)?.as_bool() {
                return Err(DefaultFailure::Ancestry);
            }
            let kind = element.CurrentControlType().map_err(|_| DefaultFailure::Query)?;
            if kind != UIA_ButtonControlTypeId && kind != UIA_SplitButtonControlTypeId {
                return Err(DefaultFailure::Query); // search metadata changed; never silently skip
            }
            if !Self::legacy_pattern_available(element).map_err(|_| DefaultFailure::Legacy)? {
                return Err(DefaultFailure::Legacy); // unsupported is not known non-default
            }
            let legacy = element.GetCurrentPatternAs::<IUIAutomationLegacyIAccessiblePattern>(
                UIA_LegacyIAccessiblePatternId).map_err(|_| DefaultFailure::Legacy)?;
            let state = legacy.CurrentState().map_err(|_| DefaultFailure::Legacy)?;
            if state & STATE_SYSTEM_PROTECTED != 0 { return Err(DefaultFailure::Ancestry); }
            Ok(state)
        }
    }

    fn validate_default_ancestry(&self, element: IUIAutomationElement,
        root: &IUIAutomationElement, pid: i32) -> Result<(), DefaultFailure> {
        let walker = unsafe { self.api.RawViewWalker() }.map_err(|_| DefaultFailure::Ancestry)?;
        ancestry::walk(element, root, |node| self.validate_element(node, pid),
            |node| unsafe { walker.GetParentElement(node) }.map_err(|e| error("UIA default ancestor", e)),
            |a, b| unsafe { self.api.CompareElements(a, b) }.map(|v| v.as_bool())
                .map_err(|e| error("UIA default ancestry comparison", e)), || self.budget())
            .map_err(|e| if e == "accessibility query budget exceeded" { DefaultFailure::Budget }
                else { DefaultFailure::Ancestry })?;
        Ok(())
    }

    /// Complete candidate search, not a traversal of unrelated layout containers.
    /// Unknown/ambiguous/protected/incomplete results still refuse activation.
    fn default_button(&self, root: &IUIAutomationElement, focused: &IUIAutomationElement,
        pid: i32) -> Result<(bool, Option<AxElement>), DefaultFailure> {
        self.validate_element(root, pid).map_err(|_| DefaultFailure::Ancestry)?;
        let candidates = self.default_candidates(root)?;
        let count = match &candidates {
            Some(found) => unsafe { found.Length() }.map_err(|_| DefaultFailure::Query)?,
            None => 0, // only complete S_OK may reach this known-empty case
        };
        let selected = unique_default(count, |index| {
            self.budget().map_err(|_| DefaultFailure::Budget)?;
            let node = unsafe { candidates.as_ref().ok_or(DefaultFailure::Query)?.GetElement(index) }
                .map_err(|_| DefaultFailure::Query)?;
            let state = self.default_state(&node, pid)?;
            Ok((state & STATE_SYSTEM_DEFAULT != 0).then_some(node))
        })?;
        let Some(selected) = selected else {
            self.budget().map_err(|_| DefaultFailure::Budget)?;
            return Ok((false, None));
        };
        // No label was read during enumeration. Even the unique selected default
        // must pass its entire actionable raw ancestry before it can be described.
        self.validate_default_ancestry(selected.clone(), root, pid)?;
        if self.default_state(&selected, pid)? & STATE_SYSTEM_DEFAULT == 0 {
            return Err(DefaultFailure::Legacy); // state changed during discovery
        }
        let focused_default = unsafe { self.api.CompareElements(&selected, focused) }
            .map_err(|_| DefaultFailure::Query)?.as_bool();
        let description = self.describe(&selected, pid).map_err(|_| DefaultFailure::Ancestry)?;
        self.budget().map_err(|_| DefaultFailure::Budget)?;
        Ok((focused_default, Some(description)))
    }

    pub fn focused(&self) -> Result<FocusFacts, String> {
        self.focused_query(true, None, true)
    }

    pub fn focused_target(&self) -> Result<FocusFacts, String> {
        self.focused_query(false, None, false)
    }

    pub(super) fn focused_for_input(&self, event: &super::super::InputEvent) -> Result<FocusFacts, String> {
        self.focused_query(true, Some(event), false)
    }

    fn focused_query(&self, read_identity: bool, event: Option<&super::super::InputEvent>, read_all_defaults: bool) -> Result<FocusFacts, String> {
        self.budget()?;
        let window = identity::foreground()?;
        let app = identity::identity(window)?;
        let focused = unsafe { self.api.GetFocusedElement() }.map_err(|e| error("UIA focus", e))?;
        // Checking ancestry also catches nonactivating panels with a different window
        // root even if the process matches the foreground application's PID.
        let chain = self.chain(focused.clone(), window, app.pid)?;
        if !unsafe { focused.CurrentHasKeyboardFocus() }.map_err(|e| error("UIA keyboard focus", e))?.as_bool() {
            return Err("UIA target does not own keyboard focus".into());
        }
        let frame = unsafe { focused.CurrentBoundingRectangle() }.ok().and_then(|r| PixelRect::from_rect(r).ok());
        // Initial observations preserve unknown identity on provider failure. Input
        // admission requires a validated opaque ID; capture/pointer preflight skips it.
        let runtime_id = if read_identity {
            if event.is_some() { Some(self.runtime_id(&focused)?) }
            else { self.runtime_id(&focused).ok() }
        } else { None };
        let mut focus = Focus { element: chain[0].clone(), is_default_button: false, default_button: None };
        // Retain full metadata for conservative key/non-field admission; only
        // ordinary field text may skip unrelated default-button discovery.
        let read_default = read_all_defaults || event.is_some_and(|event| super::needs_full_focus_metadata(event, &focus));
        let default = if read_default {
            let root = unsafe { self.api.ElementFromHandle(window) }.map_err(|e| error("UIA focus window", e))?;
            self.default_button(&root, &focused, app.pid)
        } else { Err(DefaultFailure::NotRequested) };
        let default_failure = default.as_ref().err().copied();
        let default_known = default.is_ok();
        let (is_default_button, default_button) = default.unwrap_or((false, None));
        if !unsafe { focused.CurrentHasKeyboardFocus() }
            .map_err(|e| error("UIA final keyboard focus", e))?.as_bool() {
            return Err("UIA keyboard focus changed during query".into());
        }
        if identity::foreground()? != window || identity::identity(window)? != app {
            return Err("foreground changed during accessibility query".into());
        }
        focus.is_default_button = is_default_button;
        focus.default_button = default_button;
        self.budget()?;
        Ok(FocusFacts { window: window.0 as usize, app,
            focus, default_known, default_failure, frame, runtime_id })
    }
}

pub fn focused_frame() -> Result<PixelRect, String> {
    let _dpi = Dpi::enter()?;
    identity::normal_desktop()?;
    Automation::new()?.focused()?.frame.ok_or_else(|| "focused physical frame unavailable".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::Win32::System::{Ole::{SafeArrayCreateVector, SafeArrayPutElement},
        Variant::{VARENUM, VT_R8}};

    #[test]
    fn default_query_failure_is_never_known_empty() {
        use std::cell::Cell;
        struct Owned<'a>(&'a Cell<usize>);
        impl Drop for Owned<'_> { fn drop(&mut self) { self.0.set(self.0.get() + 1); } }
        for status in [HRESULT(1), HRESULT(0x80004003u32 as i32), HRESULT(0x80004005u32 as i32)] {
            assert!(complete_default_query::<usize>(status, None).is_err());
            let drops = Cell::new(0);
            assert!(complete_default_query(status, Some(Owned(&drops))).is_err());
            assert_eq!(drops.get(), 1);
        }
        assert_eq!(complete_default_query::<usize>(HRESULT(0), None), Ok(None));
        assert_eq!(complete_default_query(HRESULT(0), Some(7)), Ok(Some(7)));
    }

    #[test]
    fn sparse_defaults_ignore_layout_and_disabled_nondefaults() {
        // Search returns buttons only: 120 layout nodes do not consume the budget.
        let layout_nodes = 120;
        assert!(layout_nodes > MAX_DEFAULT_CANDIDATES);
        let buttons = [(false, false), (true, true)]; // (enabled, legacy default)
        let selected = unique_default(buttons.len() as i32, |i| {
            let (_, is_default) = buttons[i as usize];
            Ok(is_default.then_some(i))
        }).unwrap();
        assert_eq!(selected, Some(1)); // disabled non-default never needs a label
        assert_eq!(unique_default::<usize>(64, |_| Ok(None)), Ok(None));
        assert_eq!(unique_default::<usize>(65, |_| panic!("over-budget must not inspect")), Err(DefaultFailure::Candidates));
        assert_eq!(unique_default::<usize>(-1, |_| panic!("negative count")), Err(DefaultFailure::Candidates));
    }

    #[test]
    fn ambiguous_or_unavailable_defaults_never_read_labels() {
        use std::cell::Cell;
        for failure in [DefaultFailure::Query, DefaultFailure::Legacy, DefaultFailure::Ancestry, DefaultFailure::Budget] {
            let labels = Cell::new(0);
            let result = unique_default(2, |i| if i == 0 { Ok(Some(i)) } else { Err(failure) });
            let described = result.map(|n| n.map(|_| labels.set(labels.get() + 1)));
            assert_eq!(described, Err(failure));
            assert_eq!(labels.get(), 0);
        }
        assert_eq!(unique_default(2, |i| Ok(Some(i))), Err(DefaultFailure::Ambiguous));
        assert_eq!(unique_default::<usize>(0, |_| panic!("known-empty must not inspect")), Ok(None));
    }

    fn runtime_array(kind: VARENUM, lower: i32, length: u32) -> RuntimeIdArray {
        let raw = unsafe { SafeArrayCreateVector(kind, lower, length) };
        assert!(!raw.is_null(), "native test array allocation failed");
        RuntimeIdArray(raw)
    }

    #[test]
    fn runtime_id_array_copies_opaque_signed_values_from_nonzero_lower_bound() {
        let array = runtime_array(VT_I4, -3, 3);
        let expected = [i32::MIN, 0, i32::MAX];
        for (offset, value) in expected.iter().enumerate() {
            let index = -3 + offset as i32;
            unsafe { SafeArrayPutElement(array.0, &index, (value as *const i32).cast()) }.unwrap();
        }
        let id = runtime_id_from_array(array).unwrap();
        assert_eq!(id, expected);
        assert!(valid_runtime_id(&id));
    }

    #[test]
    fn runtime_id_array_refuses_missing_wrong_type_empty_and_oversized_arrays() {
        assert!(runtime_id_from_array(RuntimeIdArray(std::ptr::null_mut())).is_err());
        for array in [runtime_array(VT_R8, 0, 1), runtime_array(VT_I4, 0, 0),
            runtime_array(VT_I4, 0, 65)] {
            assert!(runtime_id_from_array(array).is_err());
        }
        let id = runtime_id_from_array(runtime_array(VT_I4, 0, 64)).unwrap();
        assert_eq!(id.len(), 64);
        assert!(valid_runtime_id(&id));
        let mut array = runtime_array(VT_I4, 0, 1);
        let mut value = 0i32;
        assert!(unsafe { SafeArrayGetElement(array.0, &1, (&mut value as *mut i32).cast()) }.is_err());
        array.close().unwrap();
        assert!(array.0.is_null()); // normal cleanup disarmed: Drop cannot destroy twice
    }

    #[test]
    fn legacy_availability_and_provider_failures_refuse() {
        assert!(validate_legacy_protection(Err("availability access denied".into()),
            || panic!("state must not be read after a failed capability query")).is_err());
        for failure in ["pattern access denied", "pattern timeout", "state query failed"] {
            assert!(validate_legacy_protection(Ok(true), || Err(failure.into())).is_err());
        }
        assert!(validate_legacy_protection(Ok(true), || Ok(STATE_SYSTEM_PROTECTED)).is_err());
        assert!(validate_legacy_protection(Ok(true), || Ok(0)).is_ok());
    }

    #[test]
    fn positively_absent_legacy_pattern_does_not_query_state() {
        assert!(validate_legacy_protection(Ok(false),
            || panic!("a positively absent pattern must not be requested")).is_ok());
    }

    #[test]
    fn roles_match_existing_risk_contract() {
        assert_eq!(role(UIA_ButtonControlTypeId).unwrap(), "AXButton");
        assert_eq!(role(UIA_HyperlinkControlTypeId).unwrap(), "AXLink");
        assert_eq!(role(UIA_EditControlTypeId).unwrap(), "AXTextField");
        assert!(role(UIA_CustomControlTypeId).is_err());
    }
}
