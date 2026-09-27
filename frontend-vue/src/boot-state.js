/*
 * Boot snapshot of the workspace, read exactly once per launch.
 *
 * Every session module seeds its refs from this value instead of calling
 * loadWorkspace() again, so all four tools start from the same restored state
 * and the synchronous localStorage cache is read a single time.
 */
import { loadWorkspace } from './workspace.js';

export const restoredWorkspace = loadWorkspace();
