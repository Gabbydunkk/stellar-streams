import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Keypair, nativeToScVal, scValToNative, xdr } from '@stellar/stellar-sdk';
import * as SorobanRpc from '@stellar/stellar-sdk/rpc';
import {
  CONTRACT_ID,
  createdEvent,
  eventsResponse,
  makeClient,
  mockRpc,
  streamScVal,
} from './test-helpers';

const ALICE = Keypair.random().publicKey();
const BOB = Keypair.random().publicKey();
const CAROL = Keypair.random().publicKey();
const DAVE = Keypair.random().publicKey();

/**
 * Reads the stream id out of a `get_stream` simulation so a test can both assert
 * which ids the client fetched and answer each with the matching stream.
 */
function requestedStreamId(tx: unknown): string {
  const args = (
    tx as { operations: Array<{ func: xdr.HostFunction }> }
  ).operations[0]!.func.invokeContract().args();
  return scValToNative(args[0]!).toString();
}

/**
 * Answers `get_stream` simulations with the stream whose id matches the request,
 * or a void result (→ `null`) for ids in `archived`. Records the ids fetched.
 */
function streamLookupById(archived: ReadonlySet<string> = new Set()) {
  const fetched: string[] = [];
  const impl = (tx: Parameters<SorobanRpc.Server['simulateTransaction']>[0]) => {
    const id = requestedStreamId(tx);
    fetched.push(id);
    if (archived.has(id)) {
      return Promise.resolve({
        ...eventsResponse([]),
        result: { auth: [], retval: xdr.ScVal.scvVoid() },
      } as never);
    }
    return Promise.resolve({
      result: { auth: [], retval: streamScVal({ id: BigInt(id), sender: ALICE }) },
    } as never);
  };
  return { fetched, impl };
}

describe('listStreams', () => {
  let rpc: ReturnType<typeof mockRpc>;

  beforeEach(() => {
    rpc = mockRpc();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('pages two getEvents responses, filters by the address, and fetches matches with getStream', async () => {
    // Page 1 is full (pageSize = 4) so the client must request a second page;
    // page 2 is short, which ends the scan.
    const page1 = eventsResponse(
      [
        createdEvent(1, ALICE, BOB, { ledger: 10 }),
        createdEvent(2, CAROL, ALICE, { ledger: 11 }),
        createdEvent(3, BOB, CAROL, { ledger: 12 }),
        createdEvent(4, ALICE, ALICE, { ledger: 13 }),
      ],
      { cursor: 'cursor-1', latestLedger: 1_000 },
    );
    const page2 = eventsResponse([createdEvent(5, DAVE, ALICE, { ledger: 20 })], {
      cursor: 'cursor-2',
      latestLedger: 1_000,
    });
    rpc.getEvents.mockResolvedValueOnce(page1).mockResolvedValueOnce(page2);

    const { fetched, impl } = streamLookupById();
    rpc.simulateTransaction.mockImplementation(impl);

    const streams = await makeClient().listStreams({
      address: ALICE,
      startLedger: 1,
      pageSize: 4,
    });

    // id 3 (BOB -> CAROL) does not involve ALICE and is skipped.
    expect(streams.map((s) => s.id)).toEqual(['1', '2', '4', '5']);
    expect(fetched.sort()).toEqual(['1', '2', '4', '5']);

    expect(rpc.getEvents).toHaveBeenCalledTimes(2);
    const [first, second] = rpc.getEvents.mock.calls;
    // First page uses the ledger range; the follow-up resumes by cursor, since
    // the RPC forbids mixing the two.
    expect(first[0]).toMatchObject({ startLedger: 1, limit: 4 });
    expect(first[0]).not.toHaveProperty('cursor');
    expect(second[0]).toMatchObject({ cursor: 'cursor-1', limit: 4 });
    expect(second[0]).not.toHaveProperty('startLedger');
  });

  it('filters to streams where the address is the recipient as well as the sender', async () => {
    rpc.getEvents.mockResolvedValue(
      eventsResponse(
        [
          createdEvent(1, BOB, ALICE, { ledger: 5 }),
          createdEvent(2, BOB, CAROL, { ledger: 6 }),
          createdEvent(3, ALICE, CAROL, { ledger: 7 }),
        ],
        { cursor: 'c', latestLedger: 100 },
      ),
    );
    rpc.simulateTransaction.mockImplementation(streamLookupById().impl);

    const streams = await makeClient().listStreams({ address: ALICE, startLedger: 1 });
    expect(streams.map((s) => s.id).sort()).toEqual(['1', '3']);
  });

  it('deduplicates stream ids that appear on more than one page', async () => {
    rpc.getEvents
      .mockResolvedValueOnce(
        eventsResponse([createdEvent(1, ALICE, BOB, { ledger: 10 })], {
          cursor: 'cursor-1',
          latestLedger: 1_000,
        }),
      )
      .mockResolvedValueOnce(
        eventsResponse([createdEvent(1, ALICE, BOB, { ledger: 10 })], {
          cursor: 'cursor-2',
          latestLedger: 1_000,
        }),
      );
    const { fetched, impl } = streamLookupById();
    rpc.simulateTransaction.mockImplementation(impl);

    // pageSize 1 makes each single-event page "full", so both pages are read.
    const streams = await makeClient().listStreams({
      address: ALICE,
      startLedger: 1,
      pageSize: 1,
      maxPages: 2,
    });

    expect(streams.map((s) => s.id)).toEqual(['1']);
    expect(fetched).toEqual(['1']);
  });

  it('skips events past the frozen chain tip when endLedger is defaulted', async () => {
    // No endLedger: the first page reports latestLedger 15, freezing the window.
    rpc.getEvents
      .mockResolvedValueOnce(
        eventsResponse([createdEvent(1, ALICE, BOB, { ledger: 10 })], {
          cursor: 'cursor-1',
          latestLedger: 15,
        }),
      )
      .mockResolvedValueOnce(
        eventsResponse(
          [
            createdEvent(2, ALICE, BOB, { ledger: 14 }),
            createdEvent(3, ALICE, BOB, { ledger: 30 }),
          ],
          { cursor: 'cursor-2', latestLedger: 40 },
        ),
      );
    rpc.simulateTransaction.mockImplementation(streamLookupById().impl);

    const streams = await makeClient().listStreams({
      address: ALICE,
      startLedger: 1,
      pageSize: 1,
    });
    // id 3 is at ledger 30, past the tip frozen at 15, so it is dropped.
    expect(streams.map((s) => s.id)).toEqual(['1', '2']);
  });

  it('drops a matched stream whose getStream lookup returns null (archived)', async () => {
    rpc.getEvents.mockResolvedValue(
      eventsResponse(
        [createdEvent(1, ALICE, BOB, { ledger: 10 }), createdEvent(2, ALICE, BOB, { ledger: 11 })],
        { cursor: 'c', latestLedger: 100 },
      ),
    );
    const { impl } = streamLookupById(new Set(['2']));
    rpc.simulateTransaction.mockImplementation(impl);

    const streams = await makeClient().listStreams({ address: ALICE, startLedger: 1 });
    expect(streams.map((s) => s.id)).toEqual(['1']);
  });

  it('ignores events that are not well-formed created events', async () => {
    const wrongMethod = {
      ...createdEvent(8, ALICE, BOB, { ledger: 11 }),
      topic: [
        xdr.ScVal.scvSymbol('stream'),
        xdr.ScVal.scvSymbol('withdrawn'),
        nativeToScVal(8n, { type: 'u64' }),
      ],
    } as never;
    const missingIdTopic = {
      ...createdEvent(7, ALICE, BOB, { ledger: 12 }),
      topic: [xdr.ScVal.scvSymbol('stream'), xdr.ScVal.scvSymbol('created')],
    } as never;
    rpc.getEvents.mockResolvedValue(
      eventsResponse([wrongMethod, missingIdTopic, createdEvent(1, ALICE, BOB, { ledger: 13 })], {
        cursor: 'c',
        latestLedger: 100,
      }),
    );
    rpc.simulateTransaction.mockImplementation(streamLookupById().impl);

    const streams = await makeClient().listStreams({ address: ALICE, startLedger: 1 });
    // Only id 1 is a valid ("stream","created",<id>) event; the others are skipped.
    expect(streams.map((s) => s.id)).toEqual(['1']);
    expect(rpc.getEvents.mock.calls[0]![0]).toMatchObject({
      filters: [
        { type: 'contract', contractIds: [CONTRACT_ID], topics: [['stream', 'created', '']] },
      ],
    });
  });

  it('validates the address and startLedger before making any RPC call', async () => {
    await expect(
      makeClient().listStreams({ address: 'not-an-address', startLedger: 1 }),
    ).rejects.toThrow(/Invalid address/);
    await expect(makeClient().listStreams({ address: ALICE, startLedger: -5 })).rejects.toThrow(
      /Invalid startLedger/,
    );
    await expect(makeClient().listStreams({ address: ALICE, startLedger: 1.5 })).rejects.toThrow(
      /Invalid startLedger/,
    );
    expect(rpc.calls()).toBe(0);
  });
});
