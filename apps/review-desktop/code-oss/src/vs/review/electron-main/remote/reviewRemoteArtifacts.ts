/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ReviewRemoteTarget } from "./reviewRemoteProbe.js";

export interface ReviewRemoteArtifact {
	name: string;
	url: string;
	sha256: string;
}

export const REVIEW_REMOTE_RELEASES_ENV = "DEV_FAST_REVIEW_REMOTE_RELEASES";

export interface ReviewRemoteArtifactsOptions {
	/** A base URL the user hosts, from `DEV_FAST_REVIEW_REMOTE_RELEASES`, that
	 * holds `whiteboard-remote-<version>-<target>.tar.xz` and its `.sha256`.
	 * This build has no other source of remote tarballs. */
	readonly releases?: string;
}

export class ReviewRemoteNoTarball extends Error {
	constructor() {
		super("This build has no remote tarball.");
	}
}

function releasesBase(releases: string): URL | undefined {
	try {
		const base = new URL(releases.endsWith("/") ? releases : `${releases}/`);
		return base.protocol === "http:" || base.protocol === "https:" ? base : undefined;
	} catch {
		return undefined;
	}
}

/** Where hosts download the tarball from; undefined when this build has none, or the override is not a URL. */
export function remoteReleasesOrigin(options: ReviewRemoteArtifactsOptions): string | undefined {
	return options.releases ? releasesBase(options.releases)?.origin : undefined;
}

export async function remoteArtifact(target: ReviewRemoteTarget, version: string, options: ReviewRemoteArtifactsOptions): Promise<ReviewRemoteArtifact> {
	if (!options.releases) throw new ReviewRemoteNoTarball();
	const base = releasesBase(options.releases);
	if (!base) throw new Error(`${REVIEW_REMOTE_RELEASES_ENV} is not an http or https URL: ${options.releases}`);
	const name = `whiteboard-remote-${version}-${target}.tar.xz`;
	const url = new URL(encodeURIComponent(name), base).href;
	return { name, url, sha256: await fetchSha256(`${url}.sha256`) };
}

async function fetchSha256(url: string): Promise<string> {
	const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
	if (!response.ok) throw new Error(`${url} answered ${response.status}.`);
	const sha256 = (await response.text()).trim().split(/\s/)[0];
	if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`${url} holds no sha256.`);
	return sha256;
}
