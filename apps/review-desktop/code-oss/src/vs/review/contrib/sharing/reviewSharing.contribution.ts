import { Disposable } from "../../../base/common/lifecycle.js";
import { ipcRenderer } from "../../../base/parts/sandbox/electron-browser/globals.js";
import { URI } from "../../../base/common/uri.js";
import { localize2 } from "../../../nls.js";
import { Action2, registerAction2 } from "../../../platform/actions/common/actions.js";
import { IFileDialogService } from "../../../platform/dialogs/common/dialogs.js";
import { IFileService } from "../../../platform/files/common/files.js";
import { IInstantiationService, type ServicesAccessor } from "../../../platform/instantiation/common/instantiation.js";
import {
	INotificationService,
	Severity,
} from "../../../platform/notification/common/notification.js";
import { IProgressService, ProgressLocation } from "../../../platform/progress/common/progress.js";
import { IURLService, type IURLHandler } from "../../../platform/url/common/url.js";
import {
	registerWorkbenchContribution2,
	WorkbenchPhase,
} from "../../../workbench/common/contributions.js";
import { IPathService } from "../../../workbench/services/path/common/pathService.js";
import { ReviewApiClient } from "../../common/reviewProtocol.js";
import { shareUrlFromDeepLink } from "../../common/reviewShareLink.js";
import { IReviewCanvasEditorTabsService } from "../../services/reviewCanvasEditorTabsService.js";
import { IReviewDesktopConnectionService } from "../../services/reviewDesktopConnectionService.js";

type ShareSource = { url: string } | { path: string; readOnly?: boolean };

interface ImportStatus {
	reviewId: string;
	stage: string;
	title?: string;
	error?: string;
	/** The file needs a checkout of this repository. */
	missingCheckout?: { remote?: string; name: string };
}

/** What opening a share uses. */
interface ShareServices {
	session: IReviewDesktopConnectionService;
	tabs: IReviewCanvasEditorTabsService;
	notifications: INotificationService;
	progress: IProgressService;
	dialogs: IFileDialogService;
	files: IFileService;
	paths: IPathService;
}

class MissingCheckout extends Error {
	constructor(message: string, readonly checkout: NonNullable<ImportStatus["missingCheckout"]>) {
		super(message);
	}
}

async function openShare(source: ShareSource, services: ShareServices) {
	const { session, tabs, notifications, progress } = services;
	try {
		const client = new ReviewApiClient(await session.getConnection());
		const title = "path" in source ? "Opening whiteboard file" : "Opening shared review";
		await progress.withProgress({ location: ProgressLocation.Notification, title }, async (reporter) => {
			const started = await client.post<{ reviewId: string }>("/sharing/import", source);
			for (;;) {
				const status = await client.read<ImportStatus>(`/sharing/import/${started.reviewId}`);
				if (status.stage === "error") {
					const message = status.error ?? "Could not open the shared session.";
					throw status.missingCheckout ? new MissingCheckout(message, status.missingCheckout) : new Error(message);
				}
				if (status.stage === "ready") {
					await tabs.openApiReview(status.reviewId, status.title ?? "Shared review");
					return;
				}
				const message = status.stage === "fetching"
					? "Fetching pinned commits…"
					: status.stage === "validating"
						? "Preparing pinned source…"
						: status.stage === "reading"
							? "Reading the file…"
							: "Downloading review resources…";
				reporter.report({ message });
				await new Promise((resolve) => setTimeout(resolve, 500));
			}
		});
	} catch (error) {
		const retry = { label: "Retry", run: () => openShare(source, services) };
		if (error instanceof MissingCheckout && "path" in source) {
			const { remote, name } = error.checkout;
			notifications.prompt(
				Severity.Info,
				remote
					? `This whiteboard reads code from ${remote}, and no checkout of it is open in Whiteboard. Clone it, or open the whiteboard read-only with the code lines the file carries.`
					: "This whiteboard reads code from a repository that is not open in Whiteboard. Open the whiteboard read-only with the code lines the file carries.",
				[
					...(remote ? [{ label: "Clone Repository…", run: () => cloneAndOpen(source.path, remote, name, services) }] : []),
					{ label: "Open Read-Only", run: () => openShare({ path: source.path, readOnly: true }, services) },
				],
			);
			return;
		}
		notifications.prompt(
			Severity.Error,
			error instanceof Error ? error.message : "Could not open the shared session.",
			[retry],
		);
	}
}

/** Asks where to clone a file's repository, by default in ~/projects,
 * clones it there, and opens the file on the clone. */
async function cloneAndOpen(file: string, remote: string, name: string, services: ShareServices) {
	const { session, notifications, progress, dialogs, files, paths } = services;
	const home = await paths.userHome();
	const projects = URI.joinPath(home, "projects");
	const [parent] = (await dialogs.showOpenDialog({
		title: `Choose the folder to clone ${name} into`,
		openLabel: "Clone Here",
		canSelectFiles: false,
		canSelectFolders: true,
		canSelectMany: false,
		defaultUri: (await files.exists(projects)) ? projects : home,
	})) ?? [];
	if (!parent) return;
	try {
		const client = new ReviewApiClient(await session.getConnection());
		await progress.withProgress(
			{ location: ProgressLocation.Notification, title: `Cloning ${name} into ${parent.fsPath}` },
			() => client.post("/sharing/clone", { url: remote, parent: parent.fsPath, name }),
		);
	} catch (error) {
		notifications.prompt(
			Severity.Error,
			error instanceof Error ? error.message : `Could not clone ${remote}.`,
			[
				{ label: "Try Again", run: () => cloneAndOpen(file, remote, name, services) },
				{ label: "Open Read-Only", run: () => openShare({ path: file, readOnly: true }, services) },
			],
		);
		return;
	}
	await openShare({ path: file }, services);
}

function shareServices(accessor: ServicesAccessor): ShareServices {
	return {
		session: accessor.get(IReviewDesktopConnectionService),
		tabs: accessor.get(IReviewCanvasEditorTabsService),
		notifications: accessor.get(INotificationService),
		progress: accessor.get(IProgressService),
		dialogs: accessor.get(IFileDialogService),
		files: accessor.get(IFileService),
		paths: accessor.get(IPathService),
	};
}

class SharedReviewUrlHandler extends Disposable implements IURLHandler {
	private readonly services: ShareServices;

	constructor(
		@IURLService urls: IURLService,
		@IInstantiationService instantiation: IInstantiationService,
		@INotificationService private readonly notifications: INotificationService,
	) {
		super();
		this.services = instantiation.invokeFunction(shareServices);
		this._register(urls.registerHandler(this));
		const onFile = (_event: unknown, ...args: unknown[]) => {
			const [path] = args;
			if (typeof path === "string") void openShare({ path }, this.services);
		};
		ipcRenderer.on("vscode:openWhiteboardFile", onFile);
		this._register({ dispose: () => ipcRenderer.removeListener("vscode:openWhiteboardFile", onFile) });
	}
	async handleURL(uri: URI): Promise<boolean> {
		if (uri.authority !== "share") return false;
		try {
			await openShare({ url: shareUrlFromDeepLink(uri.path, uri.query) }, this.services);
		} catch {
			this.notifications.error("Invalid Whiteboard share link.");
		}
		return true;
	}
}
registerWorkbenchContribution2(
	"review.sharing.urls",
	SharedReviewUrlHandler,
	WorkbenchPhase.BlockRestore,
);
registerAction2(
	class extends Action2 {
		constructor() {
			super({
				id: "whiteboard.openWhiteboardFile",
				title: localize2("whiteboard.openWhiteboardFile", "Open Whiteboard File…"),
				f1: true,
			});
		}
		async run(accessor: ServicesAccessor) {
			const services = shareServices(accessor);
			const [file] = (await accessor.get(IFileDialogService).showOpenDialog({
				title: "Open Whiteboard File",
				openLabel: "Open",
				canSelectFiles: true,
				canSelectFolders: false,
				canSelectMany: false,
				filters: [{ name: "Whiteboard", extensions: ["whiteboard"] }],
			})) ?? [];
			if (file) await openShare({ path: file.fsPath }, services);
		}
	},
);
