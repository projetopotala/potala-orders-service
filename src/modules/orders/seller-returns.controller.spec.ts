import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { SellerReturnsController } from './seller-returns.controller';
import { ReturnsService } from './returns.service';
import { SellerContext } from '../../common/types/authenticated-user';
import {
  SellerActiveGuard,
  SellerContextGuard,
} from '../../common/guards/seller.guard';

const SELLER_USER_ID = '00000000-0000-4000-8000-000000003001';
const SELLER_ID = '00000000-0000-4000-8000-000000003002';
const RETURN_ID = '00000000-0000-4000-8000-000000003003';

const SELLER_CONTEXT: SellerContext = {
  membershipId: '00000000-0000-4000-8000-000000003005',
  userId: SELLER_USER_ID,
  sellerId: SELLER_ID,
  membershipRole: 'OWNER' as SellerContext['membershipRole'],
  sellerStatus: 'ACTIVE' as SellerContext['sellerStatus'],
};

/**
 * Testes focados no CONTROLLER -- montagem do sellerId e delegação para
 * ReturnsService. Isolamento por tenant, paginação e o resumo da
 * dispute vinculada já são cobertos em profundidade por
 * returns.service.spec.ts e não são repetidos aqui.
 */
describe('SellerReturnsController', () => {
  function buildController() {
    const returnsService = {
      listForSeller: jest.fn(),
      getForSeller: jest.fn(),
    } as unknown as jest.Mocked<ReturnsService>;

    const controller = new SellerReturnsController(returnsService);
    return { controller, returnsService };
  }

  it('list() scopes to the authenticated store via seller.sellerId', async () => {
    const { controller, returnsService } = buildController();
    const query = { limit: 20 };
    await controller.list(SELLER_CONTEXT, query);
    expect(returnsService.listForSeller).toHaveBeenCalledWith(SELLER_ID, query);
  });

  it('getOne() scopes to the authenticated store via seller.sellerId', async () => {
    const { controller, returnsService } = buildController();
    await controller.getOne(SELLER_CONTEXT, RETURN_ID);
    expect(returnsService.getForSeller).toHaveBeenCalledWith(
      SELLER_ID,
      RETURN_ID,
    );
  });

  /**
   * SOMENTE LEITURA, pedido explícito desta rodada: não existe aqui
   * nenhuma operação de aprovação/rejeição de Return para o SELLER --
   * essa decisão continua exclusivamente com ADMIN.
   */
  it('exposes no approve/reject/decide endpoint for the seller', () => {
    const prototype = SellerReturnsController.prototype as unknown as Record<
      string,
      unknown
    >;
    expect(prototype.decide).toBeUndefined();
    expect(prototype.approve).toBeUndefined();
    expect(prototype.reject).toBeUndefined();

    const handlerNames = Object.getOwnPropertyNames(
      SellerReturnsController.prototype,
    ).filter((name) => name !== 'constructor');
    expect(handlerNames.sort()).toEqual(['list', 'getOne'].sort());
  });

  /**
   * Este bloco testa SOMENTE ParseUUIDPipe + roteamento/delegação do
   * SellerReturnsController -- não a autorização de SellerContextGuard/
   * SellerActiveGuard (responsabilidade própria, já resolvida via rede
   * por SellersServiceClient em produção). Mesmo raciocínio e mesmo
   * stub de SellerClaimsController.spec.ts: o TestingModule aqui é
   * isolado, então os guards são sobrescritos com um stub que sempre
   * libera -- sem isso, Nest tenta instanciar SellerContextGuard
   * durante compile() e falha por não achar SellersServiceClient no
   * RootTestModule.
   */
  describe('ParseUUIDPipe on :id routes (HTTP)', () => {
    let app: INestApplication | undefined;
    let returnsService: jest.Mocked<ReturnsService>;

    beforeEach(async () => {
      returnsService = {
        listForSeller: jest.fn(),
        getForSeller: jest.fn().mockResolvedValue({ id: RETURN_ID }),
      } as unknown as jest.Mocked<ReturnsService>;

      const moduleRef = await Test.createTestingModule({
        controllers: [SellerReturnsController],
        providers: [{ provide: ReturnsService, useValue: returnsService }],
      })
        .overrideGuard(SellerContextGuard)
        .useValue({ canActivate: () => true })
        .overrideGuard(SellerActiveGuard)
        .useValue({ canActivate: () => true })
        .compile();

      app = moduleRef.createNestApplication();
      app.use(
        (
          req: { sellerContext?: SellerContext },
          _res: unknown,
          next: () => void,
        ) => {
          req.sellerContext = SELLER_CONTEXT;
          next();
        },
      );
      await app.init();
    });

    afterEach(async () => {
      await app?.close();
    });

    it('rejects a non-UUID return id with 400', async () => {
      if (!app) {
        throw new Error('app was not initialized');
      }
      await request(app.getHttpServer())
        .get('/seller/returns/not-a-uuid')
        .expect(400);
      expect(returnsService.getForSeller).not.toHaveBeenCalled();
    });

    it('accepts a valid UUID return id and reaches the service', async () => {
      if (!app) {
        throw new Error('app was not initialized');
      }
      await request(app.getHttpServer())
        .get(`/seller/returns/${RETURN_ID}`)
        .expect(200);
      expect(returnsService.getForSeller).toHaveBeenCalledWith(
        SELLER_ID,
        RETURN_ID,
      );
    });

    it('lists via GET /seller/returns', async () => {
      if (!app) {
        throw new Error('app was not initialized');
      }
      await request(app.getHttpServer()).get('/seller/returns').expect(200);
      expect(returnsService.listForSeller).toHaveBeenCalledWith(SELLER_ID, {});
    });
  });
});
