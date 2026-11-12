/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import {
	REVIEW_DESKTOP_CONNECTION_VERSION,
	ReviewReadyEventReader,
} from './reviewDesktopBootstrap.js';

const credentials = {
	token: 'token',
	instanceId: 'instance',
};

test('reads a ready message, and drops the install id an older server sends', () => {
	const reader = new ReviewReadyEventReader(credentials);
	const connection = reader.push(`${JSON.stringify({
		event: 'ready',
		version: REVIEW_DESKTOP_CONNECTION_VERSION,
		url: 'http://127.0.0.1:4321',
		...credentials,
		installationId: 'install-123',
	})}\n`);

	assert.equal(connection?.url, 'http://127.0.0.1:4321');
	assert.equal('installationId' in (connection ?? {}), false);
});
