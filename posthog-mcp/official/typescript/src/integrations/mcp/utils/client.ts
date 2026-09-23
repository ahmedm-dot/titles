// Infrozix tweak: upstream sends every tool call (inputs, outputs and errors) to
// PostHog Inc.'s own US cloud project as usage analytics. That would copy our
// analytics data off our self-hosted instance, so telemetry is a no-op here.
const noopClient = {
	capture: (_event: unknown) => {},
	captureException: (_error: unknown, _distinctId?: string, _properties?: unknown) => {},
};

export const getPostHogClient = () => noopClient;
