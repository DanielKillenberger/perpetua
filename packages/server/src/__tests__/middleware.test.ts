/**
 * Tests for API key authentication middleware
 */

import { FastifyRequest, FastifyReply } from 'fastify';
import { requireApiKey } from '../middleware';

describe('API Key Middleware', () => {
  let mockRequest: Partial<FastifyRequest>;
  let mockReply: Partial<FastifyReply>;
  let sendSpy: jest.Mock;
  let codeSpy: jest.Mock;

  beforeEach(() => {
    // Set test API key
    process.env.API_KEY = 'test-api-key-12345';

    sendSpy = jest.fn().mockReturnValue(undefined);
    codeSpy = jest.fn().mockReturnValue({ send: sendSpy });

    mockReply = {
      code: codeSpy,
      send: sendSpy,
    } as unknown as FastifyReply;
  });

  afterEach(() => {
    delete process.env.API_KEY;
  });

  test('should accept valid API key in Authorization header', async () => {
    mockRequest = {
      headers: { authorization: 'Bearer test-api-key-12345' },
    } as unknown as FastifyRequest;

    await requireApiKey(mockRequest as FastifyRequest, mockReply as FastifyReply);

    // On valid key, reply should not be called
    expect(codeSpy).not.toHaveBeenCalled();
  });

  test('should reject invalid API key', async () => {
    mockRequest = {
      headers: { authorization: 'Bearer wrong-key' },
    } as unknown as FastifyRequest;

    await requireApiKey(mockRequest as FastifyRequest, mockReply as FastifyReply);

    expect(codeSpy).toHaveBeenCalledWith(401);
    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'Unauthorized' })
    );
  });

  test('should reject missing Authorization header', async () => {
    mockRequest = {
      headers: {},
    } as unknown as FastifyRequest;

    await requireApiKey(mockRequest as FastifyRequest, mockReply as FastifyReply);

    expect(codeSpy).toHaveBeenCalledWith(401);
    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'Unauthorized',
        message: expect.stringContaining('Bearer'),
      })
    );
  });

  test('should reject malformed Authorization header', async () => {
    mockRequest = {
      headers: { authorization: 'Basic dXNlcjpwYXNz' },
    } as unknown as FastifyRequest;

    await requireApiKey(mockRequest as FastifyRequest, mockReply as FastifyReply);

    expect(codeSpy).toHaveBeenCalledWith(401);
  });

  test('should not call reply methods for valid API key', async () => {
    // When API key is valid, the function should return undefined without calling reply methods
    mockRequest = {
      headers: { authorization: 'Bearer test-api-key-12345' },
    } as unknown as FastifyRequest;

    const result = await requireApiKey(mockRequest as FastifyRequest, mockReply as FastifyReply);

    // Valid key should not trigger any reply methods
    expect(result).toBeUndefined();
    expect(codeSpy).not.toHaveBeenCalled();
  });
});
