import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AdminDisputesController } from './admin-disputes.controller';
import { DisputesService } from './disputes.service';
import { Role } from '../../common/types/identity-enums';
import { AuthenticatedUser } from '../../common/types/authenticated-user';
import { RecordDisputeDecisionDto } from './dto/record-dispute-decision.dto';

const ADMIN_USER_ID = '00000000-0000-4000-8000-000000004001';
const DISPUTE_ID = '00000000-0000-4000-8000-000000004002';

const ADMIN_USER: AuthenticatedUser = {
  id: ADMIN_USER_ID,
  email: 'admin@test.com',
  status: 'ACTIVE' as AuthenticatedUser['status'],
  roles: [Role.ADMIN],
};

const ADMIN_ACTOR = { role: Role.ADMIN, userId: ADMIN_USER_ID };

/**
 * Testes focados no CONTROLLER -- montagem do PostSaleActor e delegação
 * para DisputesService. Ownership, allow-list de status e CAS já são
 * cobertos em profundidade por disputes.service.spec.ts e não são
 * repetidos aqui.
 */
describe('AdminDisputesController', () => {
  function buildController() {
    const disputesService = {
      listForAdmin: jest.fn(),
      getForAdmin: jest.fn(),
      recordDecision: jest.fn(),
    } as unknown as jest.Mocked<DisputesService>;

    const controller = new AdminDisputesController(disputesService);
    return { controller, disputesService };
  }

  it('list() builds an ADMIN actor from CurrentUser.id', async () => {
    const { controller, disputesService } = buildController();
    const query = { limit: 20 };
    await controller.list(ADMIN_USER, query);
    expect(disputesService.listForAdmin).toHaveBeenCalledWith(
      ADMIN_ACTOR,
      query,
    );
  });

  it('getOne() builds an ADMIN actor from CurrentUser.id', async () => {
    const { controller, disputesService } = buildController();
    await controller.getOne(ADMIN_USER, DISPUTE_ID);
    expect(disputesService.getForAdmin).toHaveBeenCalledWith(
      ADMIN_ACTOR,
      DISPUTE_ID,
    );
  });

  it('recordDecision() uses RecordDisputeDecisionDto and an ADMIN actor -- decidedByUserId never from the body', async () => {
    const { controller, disputesService } = buildController();
    const dto: RecordDisputeDecisionDto = {
      outcome: 'CUSTOMER_FAVOR' as RecordDisputeDecisionDto['outcome'],
      reason: 'evidência suficiente',
    };
    await controller.recordDecision(ADMIN_USER, DISPUTE_ID, dto);
    expect(disputesService.recordDecision).toHaveBeenCalledWith(
      DISPUTE_ID,
      ADMIN_ACTOR,
      dto,
    );
  });

  describe('ParseUUIDPipe on :id routes (HTTP)', () => {
    let app: INestApplication;
    let disputesService: jest.Mocked<DisputesService>;

    beforeEach(async () => {
      disputesService = {
        listForAdmin: jest.fn(),
        getForAdmin: jest.fn().mockResolvedValue({ id: DISPUTE_ID }),
        recordDecision: jest.fn().mockResolvedValue({ id: 'decision-1' }),
      } as unknown as jest.Mocked<DisputesService>;

      const moduleRef = await Test.createTestingModule({
        controllers: [AdminDisputesController],
        providers: [{ provide: DisputesService, useValue: disputesService }],
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

    it('rejects a non-UUID dispute id with 400', async () => {
      await request(app.getHttpServer())
        .get('/admin/disputes/not-a-uuid')
        .expect(400);
      expect(disputesService.getForAdmin).not.toHaveBeenCalled();
    });

    it('accepts a valid UUID dispute id and reaches the service', async () => {
      await request(app.getHttpServer())
        .get(`/admin/disputes/${DISPUTE_ID}`)
        .expect(200);
      expect(disputesService.getForAdmin).toHaveBeenCalledWith(
        ADMIN_ACTOR,
        DISPUTE_ID,
      );
    });

    it('rejects a non-UUID dispute id on the decisions route with 400', async () => {
      await request(app.getHttpServer())
        .post('/admin/disputes/not-a-uuid/decisions')
        .send({ outcome: 'CUSTOMER_FAVOR', reason: 'x' })
        .expect(400);
      expect(disputesService.recordDecision).not.toHaveBeenCalled();
    });
  });
});
