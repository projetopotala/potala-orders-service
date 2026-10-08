import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { ClaimStatus } from '@prisma/client';
import { AdminClaimsController } from './admin-claims.controller';
import { ClaimsService } from './claims.service';
import { DisputesService } from './disputes.service';
import { Role } from '../../common/types/identity-enums';
import { AuthenticatedUser } from '../../common/types/authenticated-user';
import { AddClaimMessageDto } from './dto/add-claim-message.dto';
import { AddClaimEvidenceDto } from './dto/add-claim-evidence.dto';

const ADMIN_USER_ID = '00000000-0000-4000-8000-000000003001';
const CLAIM_ID = '00000000-0000-4000-8000-000000003002';
const RETURN_ID = '00000000-0000-4000-8000-000000003003';

const ADMIN_USER: AuthenticatedUser = {
  id: ADMIN_USER_ID,
  email: 'admin@test.com',
  status: 'ACTIVE' as AuthenticatedUser['status'],
  roles: [Role.ADMIN],
};

/**
 * Testes focados no CONTROLLER -- montagem do PostSaleActor e delegação
 * para ClaimsService/DisputesService. Ownership, state machine e CAS já
 * são cobertos em profundidade por claims.service.spec.ts/
 * disputes.service.spec.ts e não são repetidos aqui.
 */
describe('AdminClaimsController', () => {
  function buildController() {
    const claimsService = {
      listForAdmin: jest.fn(),
      getForAdmin: jest.fn(),
      addMessage: jest.fn(),
      addEvidence: jest.fn(),
      transitionStatus: jest.fn(),
    } as unknown as jest.Mocked<ClaimsService>;

    const disputesService = {
      openFromClaim: jest.fn(),
      openFromReturn: jest.fn(),
    } as unknown as jest.Mocked<DisputesService>;

    const controller = new AdminClaimsController(
      claimsService,
      disputesService,
    );
    return { controller, claimsService, disputesService };
  }

  const ADMIN_ACTOR = { role: Role.ADMIN, userId: ADMIN_USER_ID };

  it('list() builds an ADMIN actor from CurrentUser.id', async () => {
    const { controller, claimsService } = buildController();
    const query = { limit: 20 };
    await controller.list(ADMIN_USER, query);
    expect(claimsService.listForAdmin).toHaveBeenCalledWith(ADMIN_ACTOR, query);
  });

  it('getOne() builds an ADMIN actor from CurrentUser.id', async () => {
    const { controller, claimsService } = buildController();
    await controller.getOne(ADMIN_USER, CLAIM_ID);
    expect(claimsService.getForAdmin).toHaveBeenCalledWith(
      ADMIN_ACTOR,
      CLAIM_ID,
    );
  });

  it('addMessage() unwraps dto.body and builds an ADMIN actor', async () => {
    const { controller, claimsService } = buildController();
    const dto: AddClaimMessageDto = { body: 'nota do admin' };
    await controller.addMessage(ADMIN_USER, CLAIM_ID, dto);
    expect(claimsService.addMessage).toHaveBeenCalledWith(
      CLAIM_ID,
      ADMIN_ACTOR,
      'nota do admin',
    );
  });

  it('addEvidence() passes the dto through and builds an ADMIN actor', async () => {
    const { controller, claimsService } = buildController();
    const dto: AddClaimEvidenceDto = {
      storageKey: 'k',
      fileName: 'f.png',
      mimeType: 'image/png',
      sizeBytes: 10,
    };
    await controller.addEvidence(ADMIN_USER, CLAIM_ID, dto);
    expect(claimsService.addEvidence).toHaveBeenCalledWith(
      CLAIM_ID,
      ADMIN_ACTOR,
      dto,
    );
  });

  it('escalate() calls transitionStatus with ClaimStatus.ESCALATED', async () => {
    const { controller, claimsService } = buildController();
    await controller.escalate(ADMIN_USER, CLAIM_ID);
    expect(claimsService.transitionStatus).toHaveBeenCalledWith(
      CLAIM_ID,
      ADMIN_ACTOR,
      ClaimStatus.ESCALATED,
    );
  });

  it('resolve() calls transitionStatus with ClaimStatus.RESOLVED', async () => {
    const { controller, claimsService } = buildController();
    await controller.resolve(ADMIN_USER, CLAIM_ID);
    expect(claimsService.transitionStatus).toHaveBeenCalledWith(
      CLAIM_ID,
      ADMIN_ACTOR,
      ClaimStatus.RESOLVED,
    );
  });

  it('close() calls transitionStatus with ClaimStatus.CLOSED', async () => {
    const { controller, claimsService } = buildController();
    await controller.close(ADMIN_USER, CLAIM_ID);
    expect(claimsService.transitionStatus).toHaveBeenCalledWith(
      CLAIM_ID,
      ADMIN_ACTOR,
      ClaimStatus.CLOSED,
    );
  });

  it('openDisputeFromClaim() delegates to DisputesService.openFromClaim with an ADMIN actor', async () => {
    const { controller, disputesService } = buildController();
    await controller.openDisputeFromClaim(ADMIN_USER, CLAIM_ID);
    expect(disputesService.openFromClaim).toHaveBeenCalledWith(
      ADMIN_ACTOR,
      CLAIM_ID,
    );
  });

  it('openDisputeFromReturn() delegates to DisputesService.openFromReturn with an ADMIN actor', async () => {
    const { controller, disputesService } = buildController();
    await controller.openDisputeFromReturn(ADMIN_USER, RETURN_ID);
    expect(disputesService.openFromReturn).toHaveBeenCalledWith(
      ADMIN_ACTOR,
      RETURN_ID,
    );
  });

  describe('ParseUUIDPipe on :id routes (HTTP)', () => {
    let app: INestApplication;
    let claimsService: jest.Mocked<ClaimsService>;

    beforeEach(async () => {
      claimsService = {
        listForAdmin: jest.fn(),
        getForAdmin: jest.fn().mockResolvedValue({ id: CLAIM_ID }),
        addMessage: jest.fn(),
        addEvidence: jest.fn(),
        transitionStatus: jest.fn(),
      } as unknown as jest.Mocked<ClaimsService>;

      const moduleRef = await Test.createTestingModule({
        controllers: [AdminClaimsController],
        providers: [
          { provide: ClaimsService, useValue: claimsService },
          {
            provide: DisputesService,
            useValue: { openFromClaim: jest.fn(), openFromReturn: jest.fn() },
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
          req.authUser = ADMIN_USER;
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
        .get('/admin/claims/not-a-uuid')
        .expect(400);
      expect(claimsService.getForAdmin).not.toHaveBeenCalled();
    });

    it('accepts a valid UUID claim id and reaches the service', async () => {
      await request(app.getHttpServer())
        .get(`/admin/claims/${CLAIM_ID}`)
        .expect(200);
      expect(claimsService.getForAdmin).toHaveBeenCalledWith(
        ADMIN_ACTOR,
        CLAIM_ID,
      );
    });

    it('rejects a non-UUID return id on the dispute-from-return route with 400', async () => {
      await request(app.getHttpServer())
        .post('/admin/returns/not-a-uuid/dispute')
        .expect(400);
    });
  });
});
