import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session, SessionId, KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session';
import { expandAssistantStream } from '@deepseek-ai/dsh-llm';
import { fixtures } from './fixtures/rc2.mjs';
for (const [name, events] of Object.entries(fixtures)) {
  test(`RC.2 native Session accepts ${name} fixture`, () => {
    for (const event of events) if (event.data.stream) expandAssistantStream(event.data.stream);
    assert.ok(events.every((event, seq) => event.seq === seq && KNOWN_SESSION_EVENT_TYPES.has(event.type)));
    const session = Session.create(SessionId(`fixture-${name}`), events);
    assert.equal(session.eventAt(0).type, events[0].type);
  });
}
