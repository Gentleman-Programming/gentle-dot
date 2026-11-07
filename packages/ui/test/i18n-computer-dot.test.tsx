import type { AgentState, ConnectorInfo } from "@gentle-dot/protocol";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ComputerBanner, type ComputerControls, ComputerEntry } from "../src/components/Computer.tsx";
import { DotSurface } from "../src/components/DotSurface.tsx";
import { computerCopy, computerPlatform } from "../src/computer-capabilities.ts";
import { LocaleProvider, UI_LANGUAGE_KEY } from "../src/i18n.tsx";
import { computerEn, computerEs } from "../src/i18n-computer-messages.ts";

beforeEach(() => {
	window.localStorage.setItem(UI_LANGUAGE_KEY, "es");
	vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Macintosh; Intel Mac OS X");
});
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	window.localStorage.clear();
});
const controls = (): ComputerControls => ({
	available: true,
	stop: vi.fn(),
	setYolo: vi.fn(async () => {}),
	permissions: vi.fn(async () => ({
		accessibility: false,
		screenRecording: true,
		screenshotsSupported: true,
		panicShortcut: true,
	})),
	requestPermission: vi.fn(async () => {}),
});
const info: ConnectorInfo = {
	id: "computer",
	name: "raw native name",
	reads: "Checking…",
	sends: "",
	added: true,
	enabled: true,
	mode: "read_write",
	status: "connected",
	noImages: true,
};

it("keeps bilingual key parity", () => {
	expect(Object.keys(computerEs).sort()).toEqual(Object.keys(computerEn).sort());
});

it.each(["Macintosh", "Windows NT 10.0", "Linux"])(
	"retains default-English pure guidance for %s",
	async (ua) => {
		window.localStorage.clear();
		vi.spyOn(navigator, "userAgent", "get").mockReturnValue(ua);
		const copy = computerCopy(computerPlatform(ua));
		const c = controls();
		render(
			<LocaleProvider>
				<ComputerEntry controls={c} />
				<ComputerBanner session={{}} yolo={false} stop={c.stop} />
			</LocaleProvider>,
		);
		await waitFor(() =>
			expect(screen.getByText("Helper registered · Prerequisites unavailable")).toBeInTheDocument(),
		);
		expect(screen.getByRole("region", { name: "Computer control" })).toHaveTextContent(copy.banner);
		expect(screen.getByText(copy.prerequisites)).toBeInTheDocument();
		expect(screen.getByText(copy.limits)).toBeInTheDocument();
		const stopNote = computerPlatform(ua) === "unknown"
			? "Stop still works."
			: `Stop and ${copy.panic} still work.`;
		expect(
			screen.getByText(
				`Yolo mode lets the assistant send, pay, delete, and submit without asking you first. It turns itself off after 1 hour or when the app quits; ${stopNote}`,
			),
		).toBeInTheDocument();
	},
);

it("keeps pending, failed and ready permission checks distinct without showing raw errors as authored copy", async () => {
	const c = controls();
	const permissions = vi
		.fn<ComputerControls["permissions"]>()
		.mockImplementationOnce(() => new Promise(() => {}))
		.mockRejectedValueOnce(new Error("Allowed"))
		.mockResolvedValue({ accessibility: true, screenRecording: false, screenshotsSupported: true });
	render(
		<LocaleProvider>
			<ComputerEntry controls={{ ...c, permissions }} />
		</LocaleProvider>,
	);
	expect(screen.getAllByText("Comprobando…")).toHaveLength(3);
	fireEvent.click(screen.getByRole("button", { name: "Volver a comprobar" }));
	await waitFor(() => expect(screen.getAllByText("No se pudo comprobar")).toHaveLength(2));
	expect(screen.queryByRole("button", { name: /Conceder/ })).toBeNull();
	expect(screen.queryByText("Allowed")).toBeNull();
	fireEvent.click(screen.getByRole("button", { name: "Volver a comprobar" }));
	fireEvent.click(await screen.findByRole("button", { name: "Conceder Grabación de pantalla" }));
	await waitFor(() => expect(c.requestPermission).toHaveBeenCalledExactlyOnceWith("screenRecording"));
	permissions.mockResolvedValue({ accessibility: true, screenRecording: true, screenshotsSupported: true });
	fireEvent.click(screen.getByRole("button", { name: "Volver a comprobar" }));
	await waitFor(() =>
		expect(
			screen.getByText("Ayudante registrado · Requisitos previos cumplidos actualmente"),
		).toBeInTheDocument(),
	);
	expect(screen.getByText("Cumplidos actualmente")).toBeInTheDocument();
	expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "false");
	expect(c.stop).not.toHaveBeenCalled();
});

it("localizes permissions and risk copy without translating native strings or changing callbacks/authority", async () => {
	const c = controls();
	const view = render(
		<LocaleProvider>
			<ComputerEntry info={info} controls={c} />
		</LocaleProvider>,
	);
	const entry = screen.getByRole("listitem", { name: "Ordenador" });
	await waitFor(() => expect(within(entry).getByText("No permitido")).toBeInTheDocument());
	expect(within(entry).getByText("Checking…")).toBeInTheDocument();
	expect(entry.querySelectorAll(".connector-note")[1]?.textContent).toBe("");
	expect(entry).toHaveTextContent("Ayudante registrado · Requisitos previos no disponibles");
	expect(entry).toHaveTextContent("no son una autorización de sesión");
	expect(entry).toHaveTextContent("⌥⇧Esc");
	expect(entry).toHaveTextContent("Las compilaciones de depuración pierden estos permisos");
	expect(entry).toHaveTextContent("El modelo actual no acepta imágenes");
	fireEvent.click(within(entry).getByRole("button", { name: "Conceder Accesibilidad" }));
	await waitFor(() => expect(c.permissions).toHaveBeenCalledTimes(2));
	expect(c.requestPermission).toHaveBeenCalledExactlyOnceWith("accessibility");
	const toggle = within(entry).getByRole("switch", { name: "Modo Yolo" });
	fireEvent.click(toggle);
	expect(c.setYolo).toHaveBeenCalledExactlyOnceWith(true);
	expect(toggle).toHaveAttribute("aria-checked", "false");
	view.rerender(
		<LocaleProvider>
			<ComputerEntry info={info} controls={{ ...c, yolo: {} }} />
		</LocaleProvider>,
	);
	fireEvent.click(toggle);
	expect(c.setYolo).toHaveBeenLastCalledWith(false);
	expect(c.stop).not.toHaveBeenCalled();
});

it.each([
	["Windows NT 10.0", "Controlando tu PC con Windows", "Alt+Shift+Esc", "Solo se pueden traer al frente"],
	[
		"Linux",
		"Controlando tu ordenador",
		"Detener sigue funcionando",
		"La aplicación de escritorio debe determinar",
	],
])("keeps platform guidance distinct for %s", async (ua, banner, panic, limits) => {
	vi.spyOn(navigator, "userAgent", "get").mockReturnValue(ua);
	const c = controls();
	render(
		<LocaleProvider>
			<ComputerEntry controls={c} />
			<ComputerBanner session={{}} yolo={false} stop={c.stop} />
		</LocaleProvider>,
	);
	await waitFor(() =>
		expect(screen.getByText("Ayudante registrado · Requisitos previos no disponibles")).toBeInTheDocument(),
	);
	expect(screen.getByRole("region", { name: "Control del ordenador" })).toHaveTextContent(banner);
	expect(screen.getByText(new RegExp(panic.replace(/[+]/g, "\\+")))).toBeInTheDocument();
	expect(screen.getByText(new RegExp(limits))).toBeInTheDocument();
	expect(screen.queryByRole("button", { name: /Conceder/ })).toBeNull();
	expect(screen.queryByText(/compilaciones de depuración/)).toBeNull();
});

it.each([
	["en", "Gentle Dot: controlling your PC"],
	["es", "Gentle Dot: controlando tu PC"],
])("uses localized PC wording on the Windows Dot in %s", (locale, name) => {
	window.localStorage.setItem(UI_LANGUAGE_KEY, locale);
	vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Windows NT 10.0");
	render(
		<LocaleProvider>
			<DotSurface agentState="idle" connected inControl toggle={vi.fn()} startDrag={vi.fn()} />
		</LocaleProvider>,
	);
	expect(screen.getByRole("button", { name })).toBeInTheDocument();
});

it("shows the localized Windows screenshot prerequisite without offering a permission grant", async () => {
	vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Windows NT 10.0");
	const c = controls();
	c.permissions = vi.fn(async () => ({
		accessibility: true,
		screenRecording: true,
		screenshotsSupported: false,
	}));
	render(
		<LocaleProvider>
			<ComputerEntry controls={c} />
		</LocaleProvider>,
	);
	expect(await screen.findByText(/Windows 10 versión 2004/)).toBeInTheDocument();
	expect(screen.getByText("Ayudante registrado · Requisitos previos no disponibles")).toBeInTheDocument();
	expect(screen.queryByRole("button", { name: /Conceder/ })).toBeNull();
	expect(c.setYolo).not.toHaveBeenCalled();
});

it.each([false, undefined])("promises only Stop when native panic registration is %s", async (panicShortcut) => {
	const c = controls();
	c.permissions = vi.fn(async () => ({
		accessibility: true,
		screenRecording: true,
		screenshotsSupported: true,
		panicShortcut,
	}));
	render(
		<LocaleProvider>
			<ComputerEntry controls={c} />
		</LocaleProvider>,
	);
	await waitFor(() => expect(screen.getByText(/Detener sigue funcionando/)).toBeInTheDocument());
	expect(screen.queryByText(/⌥⇧Esc/)).toBeNull();
});

it("distinguishes an unknown Windows version from a known unsupported version in Spanish", async () => {
	vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Windows NT 10.0");
	const c = controls();
	c.permissions = vi.fn<ComputerControls["permissions"]>(async () => ({
		accessibility: true,
		screenRecording: true,
		screenshotsSupported: false,
		screenshotsUnsupported: "unknownVersion",
	}));
	render(
		<LocaleProvider>
			<ComputerEntry controls={c} />
		</LocaleProvider>,
	);
	expect(await screen.findByText(computerEs["computer.windows.unknownVersion"])).toBeInTheDocument();
	expect(screen.queryByText(computerEs["computer.windows.screenshotsUnsupported"])).toBeNull();
});

it("localizes countdown and Stop while retaining timestamps, timer updates, and exact callback", async () => {
	vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
	vi.setSystemTime(1_800_000_000_000);
	const stop = vi.fn();
	const view = render(
		<LocaleProvider>
			<ComputerBanner session={{ endsAt: Date.now() + 90_000 }} yolo stop={stop} />
		</LocaleProvider>,
	);
	const banner = screen.getByRole("region", { name: "Control del ordenador" });
	expect(banner).toHaveTextContent("Controlando tu Mac · quedan 01:30");
	expect(
		within(banner).getByTitle("Las acciones de riesgo se ejecutan sin preguntarte antes"),
	).toHaveTextContent("Yolo");
	await act(async () => vi.advanceTimersByTime(1000));
	expect(banner).toHaveTextContent("quedan 01:29");
	fireEvent.click(within(banner).getByRole("button", { name: "Detener" }));
	expect(stop).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: "click" }));
	view.rerender(
		<LocaleProvider>
			<ComputerBanner session={{}} yolo={false} stop={stop} />
		</LocaleProvider>,
	);
	expect(banner).toHaveTextContent("Controlando tu Mac");
	expect(banner).not.toHaveTextContent("quedan");
});

it.each<[AgentState, string]>([
	["starting", "iniciando"],
	["idle", "listo"],
	["thinking", "pensando"],
	["working", "trabajando"],
	["needs_you", "necesita tu respuesta"],
	["restarting", "reiniciando"],
	["error", "no disponible"],
])("localizes the %s Dot label without changing keyboard/pointer callbacks", (state, label) => {
	const toggle = vi.fn();
	const startDrag = vi.fn();
	const view = render(
		<LocaleProvider>
			<DotSurface agentState={state} connected toggle={toggle} startDrag={startDrag} />
		</LocaleProvider>,
	);
	const dot = screen.getByRole("button", { name: `Gentle Dot: ${label}` });
	expect(dot).toHaveClass(`dot-${state}`);
	fireEvent.keyDown(dot, { key: "Enter" });
	fireEvent.keyDown(dot, { key: " " });
	fireEvent.pointerDown(dot, { clientX: 0, clientY: 0, button: 0 });
	fireEvent.pointerUp(dot);
	expect(toggle).toHaveBeenCalledTimes(3);
	fireEvent.pointerDown(dot, { clientX: 0, clientY: 0, button: 0 });
	fireEvent.pointerMove(dot, { clientX: 10, clientY: 10 });
	fireEvent.pointerUp(dot);
	expect(startDrag).toHaveBeenCalledTimes(1);
	expect(toggle).toHaveBeenCalledTimes(3);
	view.rerender(
		<LocaleProvider>
			<DotSurface agentState={state} connected={false} toggle={toggle} startDrag={startDrag} />
		</LocaleProvider>,
	);
	expect(dot).toHaveAccessibleName("Gentle Dot: reiniciando");
	view.rerender(
		<LocaleProvider>
			<DotSurface agentState={state} connected={false} inControl yolo toggle={toggle} startDrag={startDrag} />
		</LocaleProvider>,
	);
	expect(dot).toHaveAccessibleName("Gentle Dot: controlando tu Mac, modo Yolo activado");
	expect(dot).toHaveClass("dot-in_control", "dot-yolo");
});
