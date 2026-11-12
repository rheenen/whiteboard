/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from "node:child_process";
import { powerMonitor, session } from "electron";
import { Disposable, toDisposable } from "../../base/common/lifecycle.js";
import { join } from "../../base/common/path.js";
import { IConfigurationService } from "../../platform/configuration/common/configuration.js";
import { IEnvironmentMainService } from "../../platform/environment/electron-main/environmentMainService.js";
import { IInstantiationService } from "../../platform/instantiation/common/instantiation.js";
import {
  ILifecycleMainService,
  LifecycleMainPhase,
} from "../../platform/lifecycle/electron-main/lifecycleMainService.js";
import { ILogService } from "../../platform/log/common/log.js";
import { IProductService } from "../../platform/product/common/productService.js";
import { getResolvedShellEnv } from "../../platform/shell/node/shellEnv.js";
import { NullTelemetryService } from "../../platform/telemetry/common/telemetryUtils.js";
import { UtilityProcess } from "../../platform/utilityProcess/electron-main/utilityProcess.js";
import { IWindowsMainService } from "../../platform/windows/electron-main/windows.js";
import { resolveReviewServerEntry, type ReviewDesktopConnection } from "../common/reviewDesktopBootstrap.js";
import type {
  ReviewGatewayHostState,
  ReviewRemoteAgent,
  ReviewRemoteAgentResult,
} from "../common/reviewProtocol.js";
import {
  REVIEW_REMOTE_HOSTS_SETTING,
  REVIEW_REMOTE_INSTALL_MODES,
  REVIEW_REMOTE_INSTALL_SETTING,
} from "../common/reviewConfigurationDefaults.js";
import { remoteHostAliases } from "../common/reviewSshAlias.js";
import {
  REVIEW_REMOTE_INSTALL_NO,
  REVIEW_REMOTE_INSTALL_YES,
} from "../common/reviewSshPrompt.js";
import { reviewLoopbackCertVerdict } from "../node/reviewLoopbackCert.js";
import { reviewEnabledExtensionGroups } from "./remote/reviewEnabledExtensionGroups.js";
import {
  REVIEW_REMOTE_RELEASES_ENV,
  remoteArtifact,
  remoteReleasesOrigin,
} from "./remote/reviewRemoteArtifacts.js";
import type {
  ReviewRemoteInstallFlow,
  ReviewRemoteInstallMode,
} from "./remote/reviewRemoteHost.js";
import { closeRemoteHostWindows, ReviewRemoteHosts } from "./remote/reviewRemoteHosts.js";
import {
  openRemoteInstallConsent,
  reviewRemoteInstallConsentPath,
} from "./remote/reviewRemoteInstallConsent.js";
import { installRemote } from "./remote/reviewRemoteInstaller.js";
import { readRemoteInstallScript } from "./remote/reviewRemoteInstallScript.js";
import { createSshAskpass } from "./remote/reviewSshAskpass.js";
import {
  reviewSshBinary,
  reviewSshConfigPath,
  reviewSshControlDirectory,
  reviewSshSharesConnections,
} from "./remote/reviewSshCommand.js";
import { listSshAliases } from "./remote/reviewSshConfigAliases.js";
import { reviewSshPromptRelay } from "./remote/reviewSshPromptRelay.js";
import { ReviewServerSupervisor } from "./reviewServerSupervisor.js";

/**
 * Binds the embedded Review server's lifetime to the application's. All of the
 * supervision logic lives in `ReviewServerSupervisor`, which holds no Electron
 * dependency so it stays testable; this class only supplies the platform.
 */
export class ReviewDesktopHost extends Disposable {
  private readonly supervisor: ReviewServerSupervisor;
  private remoteHosts: ReviewRemoteHosts | undefined;
  private terminating = false;
  private disposed = false;

  private readonly onTerminationSignal = () => {
    if (this.terminating) return;
    this.terminating = true;
    void this.lifecycleMainService.kill(0);
  };

  constructor(
    @IConfigurationService
    private readonly configurationService: IConfigurationService,
    @ILogService private readonly logService: ILogService,
    @ILifecycleMainService
    private readonly lifecycleMainService: ILifecycleMainService,
    @IEnvironmentMainService
    private readonly environmentMainService: IEnvironmentMainService,
    @IProductService private readonly productService: IProductService,
    @IInstantiationService
    private readonly instantiationService: IInstantiationService,
  ) {
    super();
    let resolvedEnvironment: Promise<NodeJS.ProcessEnv> | undefined;
    const shellEnvironment = () =>
      (resolvedEnvironment ??= getResolvedShellEnv(
        this.configurationService,
        this.logService,
        this.environmentMainService.args,
        process.env,
      ));
    this.supervisor = this._register(
      new ReviewServerSupervisor({
        appRoot: this.environmentMainService.appRoot,
        channel: !this.environmentMainService.isBuilt
          ? "dev"
          : this.productService.quality === "preview"
            ? "preview"
            : "stable",
        isBuilt: this.environmentMainService.isBuilt,
        userExtensionsPath: this.environmentMainService.extensionsPath,
        appVersion:
          this.productService.reviewVersion ?? this.productService.version,
        appUrlProtocol: this.productService.urlProtocol,
        releaseChannel: this.productService.quality,
        serverEntryOverride: process.env["DEV_FAST_REVIEW_SERVER_ENTRY"],
        resolveEnvironment: shellEnvironment,
        logInfo: (message) => this.logService.info(message),
        logError: (message) => this.logService.error(message),
        createProcess: () =>
          new UtilityProcess(
            this.logService,
            NullTelemetryService,
            this.lifecycleMainService,
          ),
        onRemoteHostRestarted: (alias) => this.remoteHosts?.reattach(alias),
      }),
    );
    // DEV_FAST_REVIEW_TLS_PIN_MISMATCH=1 pins the wrong cert, so renderers fall back to plain HTTP.
    const fingerprint = process.env["DEV_FAST_REVIEW_TLS_PIN_MISMATCH"] === "1" ? "sha256/mismatch" : this.supervisor.tlsFingerprint;
    if (fingerprint)
      session.defaultSession.setCertificateVerifyProc((request, callback) =>
        callback(reviewLoopbackCertVerdict(request, fingerprint)),
      );
    this._register(
      this.lifecycleMainService.onWillShutdown((event) => {
        event.join("reviewDesktopHost", this.supervisor.stop());
        if (this.remoteHosts)
          event.join("reviewRemoteHosts", this.remoteHosts.dispose());
      }),
    );
    void this.lifecycleMainService
      .when(LifecycleMainPhase.AfterWindowOpen)
      .then(() => this.startRemoteHosts(shellEnvironment));
    process.once("SIGINT", this.onTerminationSignal);
    process.once("SIGTERM", this.onTerminationSignal);
    this.supervisor.start();
  }

  /**
   * Resolves once the embedded server has announced a validated endpoint. The
   * renderer awaits this instead of reading bootstrap environment variables.
   */
  whenConnected(): Promise<ReviewDesktopConnection> {
    return this.supervisor.whenConnected();
  }

  stageRustAnalyzer(): void {
    this.supervisor.stageRustAnalyzer();
  }

  listSshAliases(): Promise<string[]> {
    return listSshAliases(reviewSshConfigPath());
  }

  async retryRemoteHost(alias: string): Promise<void> {
    await this.remoteHosts?.retry(alias);
  }

  async getRemoteLanguageEndpoint(serverId: string) {
    const manager = this.remoteHosts;
    const states = manager && (await this.remoteHostStates());
    return states && manager.languageEndpoint(serverId, states).catch(() => undefined);
  }

  async getRemoteHostState(serverId: string, last?: string) {
    const manager = this.remoteHosts;
    const states = manager && (await this.remoteHostStates());
    return states && manager.hostState(serverId, states, last);
  }

  private async remoteHostStates(): Promise<ReviewGatewayHostState[] | undefined> {
    try {
      const { url, token } = await this.whenConnected();
      const response = await fetch(new URL("/remote-hosts", url), {
        headers: { "x-review-token": token },
      });
      return response.ok ? ((await response.json()) as ReviewGatewayHostState[]) : undefined;
    } catch {
      return undefined;
    }
  }

  installRemoteHost(alias: string): Promise<void> {
    return this.remoteHosts?.install(alias) ?? Promise.resolve();
  }

  detectRemoteAgents(alias: string, refresh?: boolean): Promise<ReviewRemoteAgent[] | undefined> {
    return this.remoteHosts?.detectAgents(alias, refresh) ?? Promise.resolve(undefined);
  }

  connectRemoteAgents(alias: string, ids: readonly unknown[]): Promise<ReviewRemoteAgentResult[]> {
    if (!this.remoteHosts) return Promise.reject(new Error("Remote hosts are off."));
    return this.remoteHosts.connectAgents(alias, ids);
  }

  async uninstallRemoteHost(alias: string): Promise<string | null> {
    if (!this.remoteHosts) return "Remote hosts are off.";
    try {
      await this.remoteHosts.uninstall(alias);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  private remoteInstallFlow(): ReviewRemoteInstallFlow {
    const { userDataPath, appRoot, isBuilt } = this.environmentMainService;
    let script: Promise<string> | undefined;
    const artifactsOptions = {
      releases: process.env[REVIEW_REMOTE_RELEASES_ENV],
    };
    return {
      mode: () => {
        const mode = this.configurationService.getValue(
          REVIEW_REMOTE_INSTALL_SETTING,
        );
        return REVIEW_REMOTE_INSTALL_MODES.includes(
          mode as ReviewRemoteInstallMode,
        )
          ? (mode as ReviewRemoteInstallMode)
          : "ask";
      },
      consent: openRemoteInstallConsent(
        reviewRemoteInstallConsentPath(userDataPath),
      ),
      confirm: async (request) => {
        const answer = await reviewSshPromptRelay.prompt({
          ...request,
          kind: "install",
        });
        return answer === REVIEW_REMOTE_INSTALL_YES
          ? true
          : answer === REVIEW_REMOTE_INSTALL_NO
            ? false
            : undefined;
      },
      run: installRemote,
      origin: () => remoteReleasesOrigin(artifactsOptions),
      artifact: (target, version) =>
        remoteArtifact(target, version, artifactsOptions),
      script: () =>
        (script ??= readRemoteInstallScript(
          resolveReviewServerEntry({
            isBuilt,
            appRoot,
            serverEntryOverride: process.env["DEV_FAST_REVIEW_SERVER_ENTRY"],
            join,
          }),
        )),
    };
  }

  private startRemoteHosts(
    shellEnvironment: () => Promise<NodeJS.ProcessEnv>,
  ): void {
    if (this.disposed) return;
    let version: Promise<string> | undefined;
    const ssh = reviewSshBinary();
    const manager = new ReviewRemoteHosts({
      // A detached ssh gets a console window on Windows; direct sessions never prompt there.
      spawn: (args, options) =>
        spawn(
          ssh,
          args,
          process.platform === "win32"
            ? { ...options, detached: false, windowsHide: true }
            : options,
        ),
      controlDirectory: reviewSshSharesConnections()
        ? reviewSshControlDirectory()
        : undefined,
      instance: this.environmentMainService.userDataPath,
      environment: async () => ({
        ...process.env,
        ...(await shellEnvironment().catch(() => ({}))),
      }),
      createAskpass: (input) => createSshAskpass(input),
      prompt: (request) => reviewSshPromptRelay.prompt(request),
      desktopVersion: () => (version ??= this.desktopVersion()),
      desktopCommit: this.productService.commit,
      groups: () =>
        reviewEnabledExtensionGroups(this.environmentMainService.extensionsPath),
      send: (hosts) => this.supervisor.setRemoteHosts(hosts),
      log: (message) => this.logService.info(`[Remote hosts] ${message}`),
      install: this.remoteInstallFlow(),
      removed: (serverId) =>
        this.instantiationService.invokeFunction((accessor) =>
          closeRemoteHostWindows(accessor.get(IWindowsMainService), serverId),
        ),
    });
    this.remoteHosts = manager;
    const update = () => {
      manager.update(
        remoteHostAliases(
          this.configurationService.getValue(REVIEW_REMOTE_HOSTS_SETTING),
        ),
      );
    };
    const onResume = () => manager.resume();
    const onExit = () => manager.killNow();
    powerMonitor.on("resume", onResume);
    process.once("exit", onExit);
    this._register(
      toDisposable(() => {
        powerMonitor.off("resume", onResume);
        process.off("exit", onExit);
        void manager.dispose();
      }),
    );
    this._register(
      this.configurationService.onDidChangeConfiguration((event) => {
        if (
          event.affectsConfiguration(REVIEW_REMOTE_HOSTS_SETTING) ||
          event.affectsConfiguration(REVIEW_REMOTE_INSTALL_SETTING)
        )
          update();
      }),
    );
    update();
  }

  private async desktopVersion(): Promise<string> {
    const fallback =
      this.productService.reviewVersion ?? this.productService.version;
    try {
      const { url } = await this.whenConnected();
      const response = await fetch(new URL("/health", url));
      const { version } = (await response.json()) as { version?: unknown };
      return typeof version === "string" ? version : fallback;
    } catch {
      return fallback;
    }
  }

  override dispose(): void {
    this.disposed = true;
    process.off("SIGINT", this.onTerminationSignal);
    process.off("SIGTERM", this.onTerminationSignal);
    super.dispose();
  }
}
