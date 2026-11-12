/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";

import { remoteArtifact, remoteReleasesOrigin, ReviewRemoteNoTarball } from "./reviewRemoteArtifacts.js";

const servers: Server[] = [];

after(() => {
	for (const server of servers) server.close();
});

async function serve(files: Record<string, string>) {
	const requests: string[] = [];
	const server = createServer((request, response) => {
		requests.push(request.url ?? "");
		const body = files[request.url ?? ""];
		response.writeHead(body === undefined ? 404 : 200);
		response.end(body);
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}

test("the releases URL may be plain http, and the checksum is read beside the tarball", async () => {
	const name = "whiteboard-remote-0.2.4%2Bdev.abc-linux-x64.tar.xz";
	const { base, requests } = await serve({ [`/dev/${name}.sha256`]: `${"c".repeat(64)}  whiteboard-remote-0.2.4+dev.abc-linux-x64.tar.xz\n` });

	for (const releases of [`${base}/dev`, `${base}/dev/`]) {
		const options = { releases };
		assert.equal(remoteReleasesOrigin(options), base);
		assert.deepEqual(await remoteArtifact("linux-x64", "0.2.4+dev.abc", options), {
			name: "whiteboard-remote-0.2.4+dev.abc-linux-x64.tar.xz",
			url: `${base}/dev/${name}`,
			sha256: "c".repeat(64),
		});
	}
	assert.deepEqual(requests, [`/dev/${name}.sha256`, `/dev/${name}.sha256`]);
	await assert.rejects(remoteArtifact("linux-arm64", "0.2.4+dev.abc", { releases: base }), /answered 404/);
	for (const releases of ["file:///tmp/releases", "not a url"]) {
		assert.equal(remoteReleasesOrigin({ releases }), undefined);
		await assert.rejects(remoteArtifact("linux-x64", "1.2.3", { releases }), /DEV_FAST_REVIEW_REMOTE_RELEASES is not an http or https URL/);
	}
});

test("without a releases URL there is no tarball and nothing is fetched", async () => {
	assert.equal(remoteReleasesOrigin({}), undefined);
	await assert.rejects(remoteArtifact("linux-x64", "1.2.3", {}), ReviewRemoteNoTarball);
});
