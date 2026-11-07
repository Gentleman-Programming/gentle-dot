// Renderer-owned display only; native permissions, sessions and accelerators stay raw.
export const computerEn = {
	"computer.name": "Computer",
	"computer.builtIn": "Built in",
	"computer.control": "Computer control",
	"computer.stop": "Stop",
	"computer.left": "{time} left",
	"computer.accessibility": "Accessibility",
	"computer.screenRecording": "Screen Recording",
	"computer.registered": "Helper registered",
	"computer.checkingPrerequisites": "Checking prerequisites…",
	"computer.prerequisitesMet": "Current prerequisites met",
	"computer.prerequisitesUnavailable": "Prerequisites unavailable",
	"computer.checking": "Checking…",
	"computer.unable": "Unable to check",
	"computer.allowed": "Allowed",
	"computer.notAllowed": "Not allowed",
	"computer.grant": "Grant",
	"computer.captureInput": "Capture and input prerequisites",
	"computer.currentlyMet": "Currently met",
	"computer.unavailable": "Unavailable",
	"computer.checkAgain": "Check again",
	"computer.yoloMode": "Yolo mode",
	"computer.yoloRisk": "Risky actions run without asking you first",
	"computer.yoloNote":
		"Yolo mode lets the assistant send, pay, delete, and submit without asking you first. It turns itself off after 1 hour or when the app quits;",
	"computer.panicNote": "Stop and {panic} still work.",
	"computer.stopNote": "Stop still works.",
	"computer.debug":
		"Debug builds lose these permissions on every rebuild because macOS ties them to the app's signature; grant them again after updating.",
	"computer.noImages":
		"The current model does not accept images, so the assistant cannot see your screen. Choose a model that does in Profiles.",
	"computer.mac.banner": "Controlling your Mac",
	"computer.mac.prerequisites":
		"Current permissions and screenshot support are not a session grant. The app asks you to allow a session separately.",
	"computer.mac.limits": "Stop ends the session and drops queued actions.",
	"computer.windows.banner": "Controlling your Windows PC",
	"computer.windows.screenshotsUnsupported":
		"Computer control needs Windows 10 version 2004 (build 19041) or newer for screenshots.",
	"computer.windows.unknownVersion":
		"Gentle Dot cannot tell which Windows version this is, so computer control is unavailable: screenshots need Windows 10 version 2004 (build 19041) or newer.",
	"computer.windows.prerequisites":
		"Current native prerequisites are not a session grant or a promise that the next action will succeed. The app asks you to allow a session separately. No permission can be granted here.",
	"computer.windows.limits":
		"Only verified running apps can be brought forward; cold launch and cross-app drag are unsupported. Stop drops queued actions; an already-inserted input batch may finish.",
	"computer.unknown.banner": "Controlling your computer",
	"computer.unknown.prerequisites":
		"Platform-specific guidance is unavailable. Helper registration and current prerequisites are not a session grant.",
	"computer.unknown.limits":
		"Use Stop to end the session. Native support must be established by the desktop app.",
	"computer.unknown.panic": "the native emergency shortcut",
	"dot.starting": "starting",
	"dot.idle": "ready",
	"dot.thinking": "thinking",
	"dot.working": "working",
	"dot.needs_you": "needs your answer",
	"dot.restarting": "restarting",
	"dot.error": "unavailable",
	"dot.control": "controlling your Mac",
	"dot.windows.control": "controlling your PC",
	"dot.unknown.control": "controlling your computer",
	"dot.yolo": ", yolo mode on",
} as const;

export const computerEs: Record<keyof typeof computerEn, string> = {
	"computer.name": "Ordenador",
	"computer.builtIn": "Integrado",
	"computer.control": "Control del ordenador",
	"computer.stop": "Detener",
	"computer.left": "quedan {time}",
	"computer.accessibility": "Accesibilidad",
	"computer.screenRecording": "Grabación de pantalla",
	"computer.registered": "Ayudante registrado",
	"computer.checkingPrerequisites": "Comprobando requisitos previos…",
	"computer.prerequisitesMet": "Requisitos previos cumplidos actualmente",
	"computer.prerequisitesUnavailable": "Requisitos previos no disponibles",
	"computer.checking": "Comprobando…",
	"computer.unable": "No se pudo comprobar",
	"computer.allowed": "Permitido",
	"computer.notAllowed": "No permitido",
	"computer.grant": "Conceder",
	"computer.captureInput": "Requisitos previos de captura y entrada",
	"computer.currentlyMet": "Cumplidos actualmente",
	"computer.unavailable": "No disponible",
	"computer.checkAgain": "Volver a comprobar",
	"computer.yoloMode": "Modo Yolo",
	"computer.yoloRisk": "Las acciones de riesgo se ejecutan sin preguntarte antes",
	"computer.yoloNote":
		"El modo Yolo permite al asistente enviar, pagar, eliminar y confirmar sin preguntarte antes. Se desactiva después de 1 hora o al cerrar la aplicación;",
	"computer.panicNote": "Detener y {panic} siguen funcionando.",
	"computer.stopNote": "Detener sigue funcionando.",
	"computer.debug":
		"Las compilaciones de depuración pierden estos permisos en cada recompilación porque macOS los vincula a la firma de la aplicación; vuelve a concederlos después de actualizar.",
	"computer.noImages":
		"El modelo actual no acepta imágenes, por lo que el asistente no puede ver tu pantalla. Elige uno que las acepte en Perfiles.",
	"computer.mac.banner": "Controlando tu Mac",
	"computer.mac.prerequisites":
		"Los permisos actuales y la compatibilidad con capturas de pantalla no son una autorización de sesión. La aplicación te pide que autorices una sesión por separado.",
	"computer.mac.limits": "Detener finaliza la sesión y descarta las acciones en cola.",
	"computer.windows.banner": "Controlando tu PC con Windows",
	"computer.windows.screenshotsUnsupported":
		"El control del ordenador necesita Windows 10 versión 2004 (compilación 19041) o posterior para las capturas de pantalla.",
	"computer.windows.unknownVersion":
		"Gentle Dot no puede determinar qué versión de Windows es esta, por lo que el control del ordenador no está disponible: las capturas de pantalla necesitan Windows 10 versión 2004 (compilación 19041) o posterior.",
	"computer.windows.prerequisites":
		"Los requisitos nativos actuales no son una autorización de sesión ni una promesa de que la siguiente acción tendrá éxito. La aplicación te pide que autorices una sesión por separado. Aquí no se puede conceder ningún permiso.",
	"computer.windows.limits":
		"Solo se pueden traer al frente aplicaciones verificadas que ya estén abiertas; no se admite iniciarlas ni arrastrar entre aplicaciones. Detener descarta las acciones en cola; un lote de entrada ya insertado puede terminar.",
	"computer.unknown.banner": "Controlando tu ordenador",
	"computer.unknown.prerequisites":
		"No hay orientación específica para esta plataforma. El registro del ayudante y los requisitos previos actuales no son una autorización de sesión.",
	"computer.unknown.limits":
		"Usa Detener para finalizar la sesión. La aplicación de escritorio debe determinar la compatibilidad nativa.",
	"computer.unknown.panic": "el atajo nativo de emergencia",
	"dot.starting": "iniciando",
	"dot.idle": "listo",
	"dot.thinking": "pensando",
	"dot.working": "trabajando",
	"dot.needs_you": "necesita tu respuesta",
	"dot.restarting": "reiniciando",
	"dot.error": "no disponible",
	"dot.control": "controlando tu Mac",
	"dot.windows.control": "controlando tu PC",
	"dot.unknown.control": "controlando tu ordenador",
	"dot.yolo": ", modo Yolo activado",
};
