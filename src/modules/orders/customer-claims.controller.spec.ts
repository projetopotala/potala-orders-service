import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { ClaimStatus } from '@prisma/client';
import { CustomerClaimsController } from './customer-claims.controller';
import { ClaimsService } from './claims.service';
import { DisputesService } from './disputes.service';
import { Role } from '../../common/types/identity-enums';
import { AuthenticatedUser } from '../../common/types/authenticated-user';
import { CreateClaimDto } from './dto/create-claim.dto';
import { AddClaimMessageDto } from './dto/add-claim-message.dto';
import { AddClaimEvidenceDto } from './dto/add-claim-evidence.dto';

const USER_ID = '00000000-0000-4000-8000-000000001001';
const CLAIM_ID = '00000000-0000-4000-8000-000000001002';
const ORDER_ID = '00000000-0000-4000-8000-000000001003';
const ITEM_ID = '00000000-0000-4000-8000-000000001004';
const RETURN_ID = '00000000-0000-4000-8000-000000001005';

const CUSTOMER_USER: AuthenticatedUser = {
  id: USER_ID,
  email: 'customer@test.com',
  status: 'ACTIVE' as AuthenticatedUser['status'],
  roles: [Role.CUSTOMER],
};

/**
 * Testes focados no CONTROLLER -- montagem do PostSaleActor e delegação
 * para ClaimsService/DisputesService. Ownership, state machine e CAS já
 * são cobertos em profundidade por claims.service.spec.ts/
 * disputes.service.spec.ts e não são repetidos aqui.
 */
describe('CustomerClaimsController', () => {
  function buildController() {
    const claimsService = {
      listForCustomer: jest.fn(),
      getForCustomer: jest.fn(),
      createClaim: jest.fn(),
      addMessage: jest.fn(),
      addEvidence: jest.fn(),
      transitionStatus: jest.fn(),
    } as unknown as jest.Mocked<ClaimsService>;

    const disputesService = {
      openFromClaim: jest.fn(),
      openFromReturn: jest.fn(),
      getForCustomer: jest.fn(),
    } as unknown as jest.Mocked<DisputesService>;

    const controller = new CustomerClaimsController(
      claimsService,
      disputesService,
    );
    return { controller, claimsService, disputesService };
  }

  it('list() scopes to the authenticated customer via user.id', async () => {
    const { controller, claimsService } = buildController();
    const query = { limit: 20 };
    await controller.list(CUSTOMER_USER, query);
    expect(claimsService.listForCustomer).toHaveBeenCalledWith(USER_ID, query);
  });

  it('getOne() scopes to the authenticated customer via user.id', async () => {
    const { controller, claimsService } = buildController();
    await controller.getOne(CUSTOMER_USER, CLAIM_ID);
    expect(claimsService.getForCustomer).toHaveBeenCalledWith(
      USER_ID,
      CLAIM_ID,
    );
  });

  it('createClaim() uses user.id as customerId, never anything from the body', async () => {
    const { controller, claimsService } = buildController();
    const dto: CreateClaimDto = { reason: 'defeituoso' };
    await controller.createClaim(CUSTOMER_USER, ORDER_ID, ITEM_ID, dto);
    expect(claimsService.createClaim).toHaveBeenCalledWith(
      USER_ID,
      ORDER_ID,
      ITEM_ID,
      dto,
    );
  });

  it('addMessage() unwraps dto.body and builds a CUSTOMER actor exclusively from CurrentUser', async () => {
    const { controller, claimsService } = buildController();
    const dto: AddClaimMessageDto = { body: 'uma mensagem' };
    await controller.addMessage(CUSTOMER_USER, CLAIM_ID, dto);
    expect(claimsService.addMessage).toHaveBeenCalledWith(
      CLAIM_ID,
      { role: Role.CUSTOMER, userId: USER_ID, customerId: USER_ID },
      'uma mensagem',
    );
  });

  it('addEvidence() passes the dto through and builds a CUSTOMER actor exclusively from CurrentUser', async () => {
    const { controller, claimsService } = buildController();
    const dto: AddClaimEvidenceDto = {
      storageKey: 'k',
      fileName: 'f.png',
      mimeType: 'image/png',
      sizeBytes: 10,
    };
    await controller.addEvidence(CUSTOMER_USER, CLAIM_ID, dto);
    expect(claimsService.addEvidence).toHaveBeenCalledWith(
      CLAIM_ID,
      { role: Role.CUSTOMER, userId: USER_ID, customerId: USER_ID },
      dto,
    );
  });

  it('resolve() calls transitionStatus with ClaimStatus.RESOLVED', async () => {
    const { controller, claimsService } = buildController();
    await controller.resolve(CUSTOMER_USER, CLAIM_ID);
    expect(claimsService.transitionStatus).toHaveBeenCalledWith(
      CLAIM_ID,
      { role: Role.CUSTOMER, userId: USER_ID, customerId: USER_ID },
      ClaimStatus.RESOLVED,
    );
  });

  it('cancel() calls transitionStatus with ClaimStatus.CANCELLED', async () => {
    const { controller, claimsService } = buildController();
    await controller.cancel(CUSTOMER_USER, CLAIM_ID);
    expect(claimsService.transitionStatus).toHaveBeenCalledWith(
      CLAIM_ID,
      { role: Role.CUSTOMER, userId: USER_ID, customerId: USER_ID },
      ClaimStatus.CANCELLED,
    );
  });

  it('openDisputeFromClaim() delegates to DisputesService.openFromClaim with a CUSTOMER actor', async () => {
    const { controller, disputesService } = buildController();
    await controller.openDisputeFromClaim(CUSTOMER_USER, CLAIM_ID);
    expect(disputesService.openFromClaim).toHaveBeenCalledWith(
      { role: Role.CUSTOMER, userId: USER_ID, customerId: USER_ID },
      CLAIM_ID,
    );
  });

  it('openDisputeFromReturn() delegates to DisputesService.openFromReturn with a CUSTOMER actor', async () => {
    const { controller, disputesService } = buildController();
    await controller.openDisputeFromReturn(CUSTOMER_USER, RETURN_ID);
    expect(disputesService.openFromReturn).toHaveBeenCalledWith(
      { role: Role.CUSTOMER, userId: USER_ID, customerId: USER_ID },
      RETURN_ID,
    );
  });

  it('getDispute() scopes to the authenticated customer via user.id (dispute originated from either Claim or Return)', async () => {
    const DISPUTE_ID = '00000000-0000-4000-8000-000000001006';
    const { controller, disputesService } = buildController();
    await controller.getDispute(CUSTOMER_USER, DISPUTE_ID);
    expect(disputesService.getForCustomer).toHaveBeenCalledWith(
      USER_ID,
      DISPUTE_ID,
    );
  });

  describe('ParseUUIDPipe on :id routes (HTTP)', () => {
    let app: INestApplication;
    let claimsService: jest.Mocked<ClaimsService>;
    let disputesServiceMock: {
      openFromClaim: jest.Mock;
      openFromReturn: jest.Mock;
      getForCustomer: jest.Mock;
    };

    beforeEach(async () => {
      claimsService = {
        listForCustomer: jest.fn(),
        getForCustomer: jest.fn().mockResolvedValue({ id: CLAIM_ID }),
        createClaim: jest.fn(),
        addMessage: jest.fn(),
        addEvidence: jest.fn(),
        transitionStatus: jest.fn(),
      } as unknown as jest.Mocked<ClaimsService>;
      disputesServiceMock = {
        openFromClaim: jest.fn(),
        openFromReturn: jest.fn(),
        getForCustomer: jest.fn().mockResolvedValue({ id: 'dispute-1' }),
      };

      const moduleRef = await Test.createTestingModule({
        controllers: [CustomerClaimsController],
        providers: [
          { provide: ClaimsService, useValue: claimsService },
          {
            provide: DisputesService,
            useValue: {
              openFromClaim: jest.fn(),
              openFromReturn: jest.fn(),
              getForCustomer: disputesServiceMock.getForCustomer,
            },
          },
        ],
      }).compile();

      app = moduleRef.createNestApplication();
      app.use(
        (
          req: { authUser?: AuthenticatedUser },
          _res: unknown,
          next: () => void,
        ) => {
          req.authUser = CUSTOMER_USER;
          next();
        },
      );
      await app.init();
    });

    afterEach(async () => {
      await app.close();
    });

    it('rejects a non-UUID claim id with 400', async () => {
      await request(app.getHttpServer())
        .get('/orders/claims/not-a-uuid')
        .expect(400);
      expect(claimsService.getForCustomer).not.toHaveBeenCalled();
    });

    it('accepts a valid UUID claim id and reaches the service', async () => {
      await request(app.getHttpServer())
        .get(`/orders/claims/${CLAIM_ID}`)
        .expect(200);
      expect(claimsService.getForCustomer).toHaveBeenCalledWith(
        USER_ID,
        CLAIM_ID,
      );
    });

    it('rejects a non-UUID orderId on the create-claim route with 400', async () => {
      await request(app.getHttpServer())
        .post(`/orders/not-a-uuid/items/${ITEM_ID}/claim`)
        .send({ reason: 'x' })
        .expect(400);
      expect(claimsService.createClaim).not.toHaveBeenCalled();
    });

    it('rejects a non-UUID dispute id with 400 on /orders/disputes/:id', async () => {
      await request(app.getHttpServer())
        .get('/orders/disputes/not-a-uuid')
        .expect(400);
      expect(disputesServiceMock.getForCustomer).not.toHaveBeenCalled();
    });

    it('accepts a valid UUID dispute id on /orders/disputes/:id and reaches the service', async () => {
      const DISPUTE_ID = '00000000-0000-4000-8000-000000001006';
      await request(app.getHttpServer())
        .get(`/orders/disputes/${DISPUTE_ID}`)
        .expect(200);
      expect(disputesServiceMock.getForCustomer).toHaveBeenCalledWith(
        USER_ID,
        DISPUTE_ID,
      );
    });
  });
});
