/*
Which Apify run produced a record.

Every pushed record carries the run id so a row in the dataset can be traced back to the run that
wrote it — datasets outlive runs and are routinely appended to by several of them.

One accessor, deliberately: `Actor.getEnv()` sprinkled across the handlers is the same lookup written
four ways, and each copy is a place for the fallback to drift. Nothing here is cached at module
scope either — the value is read from the environment on every call, so a module imported before the
platform populated the environment cannot freeze a `null` into every record of the run.
*/
import { Actor } from 'apify';

/** The current run's id, or `null` when running locally, outside the platform. */
export function currentActorRunId(): string | null {
    return Actor.getEnv().actorRunId ?? null;
}
