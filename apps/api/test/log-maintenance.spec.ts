import 'reflect-metadata';
import { LogMaintenanceService } from '../src/logging/log-maintenance.service';

jest.mock('../src/config/env', () => ({ env: jest.fn(() => ({ LOG_MAINTENANCE: 'on' })) }));

describe('log maintenance lifecycle', () => {
  afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });

  const setup = () => {
    const connect = jest.fn();
    const service = new LogMaintenanceService({ pool: { connect } } as any, { get: jest.fn().mockResolvedValue([]) } as any, {} as any);
    return { service, connect };
  };

  it('cancels both startup and recurring timers during shutdown', async () => {
    jest.useFakeTimers();
    const { service, connect } = setup();
    service.onModuleInit();
    expect(jest.getTimerCount()).toBe(2);
    await service.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(30 * 60_000);
    expect(connect).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('waits for an already running maintenance job before shutdown completes', async () => {
    const { service, connect } = setup();
    let release!: (client: unknown) => void;
    connect.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    const task = service.run();
    let stopped = false;
    const shutdown = service.onModuleDestroy().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    const client = { query: jest.fn().mockResolvedValue({ rows: [{ ok: false }] }), release: jest.fn() };
    release(client);
    await Promise.all([task, shutdown]);
    expect(client.release).toHaveBeenCalledTimes(1);
    await service.run();
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('handles scheduled connection failures without an unhandled rejection', async () => {
    jest.useFakeTimers();
    const { service, connect } = setup();
    connect.mockRejectedValue(new Error('database unavailable'));
    const log = jest.spyOn((service as any).log, 'error').mockImplementation(() => {});
    service.onModuleInit();
    await jest.advanceTimersByTimeAsync(30_000);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('database unavailable'));
    await service.onModuleDestroy();
  });
});
