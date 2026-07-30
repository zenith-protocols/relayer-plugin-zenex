/**
 * index.ts
 *
 * Main entry point for the @zenith-protocols/relayer-plugin-zenex package
 * Re-exports both the client (for external use) and the plugin handler
 */

// Export client for external consumers
export * from './client';

// Export plugin handler for the OpenZeppelin Relayer
export { handler } from './plugin/handler';
