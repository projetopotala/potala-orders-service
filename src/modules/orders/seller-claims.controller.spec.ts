import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { SellerClaimsController } from './seller-claims.controller';
import { AddClaimMessageDto } from './dto/add-claim-message.dto';
import { AddClaimEvidenceDto } from './dto/add-claim-evidence.dto';
import { ClaimsService } from './claims.service';
import { DisputesService } from './disputes.service';
import { Role } from '../../common/types/identity-enums';
import { SellerContext } from '../../common/types/authenticated-user';
import {
  SellerActiveGuard,
  SellerContextGuard,
} from '../../common/guards/seller.guard';

const SELLER_USER_ID = '00000000-0000-4000-8000-000000002001';
const SELLER_ID = '00000000-0000-4000-8000-000000002002';
const CLAIM_ID = '00000000-0000-4000-8000-000000002003';
const RETURN_ID = '00000000-0000-4000-8000-000000002004';

const SELLER_CONTEXT: SellerContext = {
  membershipId: '00000000-0000-4000-8000-000000002005',
  userId: SELLER_USER_ID,
  sellerId: SELLER_ID,
  membershipRole: 'OWNER' as SellerContext['membershipRole'],
  sellerStatus: 'ACTIVE' as SellerContext['sellerStatus'],
};

/**
 * Testes focados no CONTROLLER -- montagem do PostSaleActor e delegação
 * para ClaimsService/DisputesService. Ownership, state machine e CAS já
 * são cobertos em profundidade por claims.service.spec.ts/
 * disputes.service.spec.ts e não são repetidos aqui.
 */
describe('SellerClaimsController', () => {
  function buildController() {
    const claimsService = {
      listForSeller: jest.fn(),
      getForSeller: jest.fn(),
      addMessage: jest.fn(),
      addEvidence: jest.fn(),
    } as unknown as jest.Mocked<ClaimsService>;

    const disputesService = {
      openFromClaim: jest.fn(),
      openFromReturn: jest.fn(),
    } as unknown as jest.Mocked<DisputesService>;

    const controller = new SellerClaimsController(
      claimsService,
      disputesService,
    );
    return { controller, claimsService, disputesService };
  }

  it('list() scopes to the authenticated store via seller.sellerId', async () => {
    const { controller, claimsService } = buildController();
    const query = { limit: 20 };
    await controller.list(SELLER_CONTEXT, query);
    expect(claimsService.listForSeller).toHaveBeenCalledWith(SELLER_ID, query);
  });

  it('getOne() scopes to the authenticated store via seller.sellerId', async () => {
    const { controller, claimsService } = buildController();
    await controller.getOne(SELLER_CONTEXT, CLAIM_ID);
    expect(claimsService.getForSeller).toHaveBeenCalledWith(
      SELLER_ID,
      CLAIM_ID,
    );
  });

  it('addMessage() unwraps dto.body and builds a SELLER actor from seller.userId + seller.sellerId', async () => {
    const { controller, claimsService } = buildController();
    const dto: AddClaimMessageDto = { body: 'resposta do vendedor' };
    await controller.addMessage(SELLER_CONTEXT, CLAIM_ID, dto);
    expect(claimsService.addMessage).toHaveBeenCalledWith(
      CLAIM_ID,
      { role: Role.SELLER, userId: SELLER_USER_ID, sellerId: SELLER_ID },
      'resposta do vendedor',
    );
  });

  it('addEvidence() passes the dto through and builds a SELLER actor from seller.userId + seller.sellerId', async () => {
    const { controller, claimsService } = buildController();
    const dto: AddClaimEvidenceDto = {
      storageKey: 'k',
      fileName: 'f.png',
      mimeType: 'image/png',
      sizeBytes: 10,
    };
    await controller.addEvidence(SELLER_CONTEXT, CLAIM_ID, dto);
    expect(claimsService.addEvidence).toHaveBeenCalledWith(
      CLAIM_ID,
      { role: Role.SELLER, userId: SELLER_USER_ID, sellerId: SELLER_ID },
      dto,
    );
  });

  it('openDisputeFromClaim() delegates to DisputesService.openFromClaim with a SELLER actor', async () => {
    const { controller, disputesService } = buildController();
    await controller.openDisputeFromClaim(SELLER_CONTEXT, CLAIM_ID);
    expect(disputesService.openFromClaim).toHaveBeenCalledWith(
      { role: Role.SELLER, userId: SELLER_USER_ID, sellerId: SELLER_ID },
      CLAIM_ID,
    );
  });

  it('openDisputeFromReturn() delegates to DisputesService.openFromReturn with a SELLER actor', async () => {
    const { controller, disputesService } = buildController();
    await controller.openDisputeFromReturn(SELLER_CONTEXT, RETURN_ID);
    expect(disputesService.openFromReturn).toHaveBeenCalledWith(
      { role: Role.SELLER, userId: SELLER_USER_ID, sellerId: SELLER_ID },
      RETURN_ID,
    );
  });

  /**
   * CRÍTICO (pedido explícito de Arthur): SELLER não tem transição
   * manual de status de Claim -- nenhuma rota resolve/cancel/escalate/
   * close pode existir neste controller. Verifica tanto a ausência dos
   * métodos quanto a lista exata de handlers HTTP expostos.
   */
  it('exposes no manual claim-status-change endpoint (resolve/cancel/escalate/close)', () => {
    const prototype = SellerClaimsController.prototype as unknown as Record<
      string,
      unknown
    >;
    expect(prototype.resolve).toBeUndefined();
    expect(prototype.cancel).toBeUndefined();
    expect(prototype.escalate).toBeUndefined();
    expect(prototype.close).toBeUndefined();

    const handlerNames = Object.getOwnPropertyNames(
      SellerClaimsController.prototype,
    ).filter((name) => name !== 'constructor' && name !== 'buildActor');
    expect(handlerNames.sort()).toEqual(
      [
        'list',
        'getOne',
        'addMessage',
        'addEvidence',
        'openDisputeFromClaim',
        'openDisputeFromReturn',
      ].sort(),
    );
  });

  /**
   * Este bloco testa SOMENTE ParseUUIDPipe + roteamento/delegação do
   * SellerClaimsController -- não a autorização de SellerContextGuard/
   * SellerActiveGuard (responsabilidade própria, já resolvida via rede
   * por SellersServiceClient em produção). O TestingModule aqui é
   * isolado (sem ClientsModule, sem chamada de rede), então os guards
   * são sobrescritos com um stub que sempre libera -- sem isso, Nest
   * tenta instanciar SellerContextGuard durante compile() e falha por
   * não achar SellersServiceClient no RootTestModule. O middleware que
   * injeta req.sellerContext continua necessário à parte, pois
   * @CurrentSeller() lê diretamente de request.sellerContext.
   */
  describe('ParseUUIDPipe on :id routes (HTTP)', () => {
    let app: INestApplication | undefined;
    let claimsService: jest.Mocked<ClaimsService>;

    beforeEach(async () => {
      claimsService = {
        listForSeller: jest.fn(),
        getForSeller: jest.fn().mockResolvedValue({ id: CLAIM_ID }),
        addMessage: jest.fn(),
        addEvidence: jest.fn(),
      } as unknown as jest.Mocked<ClaimsService>;

      const moduleRef = await Test.createTestingModule({
        controllers: [SellerClaimsController],
        providers: [
          { provide: ClaimsService, useValue: claimsService },
          {
            provide: DisputesService,
            useValue: { openFromClaim: jest.fn(), openFromReturn: jest.fn() },
          },
        ],
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

    it('rejects a non-UUID claim id with 400', async () => {
      if (!app) {
        throw new Error('app was not initialized');
      }
      await request(app.getHttpServer())
        .get('/seller/claims/not-a-uuid')
        .expect(400);
      expect(claimsService.getForSeller).not.toHaveBeenCalled();
    });

    it('accepts a valid UUID claim id and reaches the service', async () => {
      if (!app) {
        throw new Error('app was not initialized');
      }
      await request(app.getHttpServer())
        .get(`/seller/claims/${CLAIM_ID}`)
        .expect(200);
      expect(claimsService.getForSeller).toHaveBeenCalledWith(
        SELLER_ID,
        CLAIM_ID,
      );
    });
  });
});
