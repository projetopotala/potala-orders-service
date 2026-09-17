import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateCheckoutDto } from './create-checkout.dto';
import {
  MAX_CHECKOUT_ITEMS,
  MAX_ITEM_QUANTITY,
} from '../../../common/constants/orders.constants';

const PRODUCT_ID = '00000000-0000-4000-8000-00000000000a';
const VARIANT_ID = '00000000-0000-4000-8000-00000000000b';

function validPayload(overrides: Record<string, unknown> = {}) {
  return {
    items: [{ productId: PRODUCT_ID, variantId: VARIANT_ID, quantity: 1 }],
    shippingAddress: {
      recipient: 'Maria Silva',
      street: 'Rua das Flores',
      number: '123',
      neighborhood: 'Centro',
      city: 'São Paulo',
      state: 'SP',
      postalCode: '01310-000',
    },
    ...overrides,
  };
}

describe('CreateCheckoutDto', () => {
  async function errorsOf(plain: Record<string, unknown>) {
    const dto = plainToInstance(CreateCheckoutDto, plain);
    return validate(dto, { whitelist: true, forbidNonWhitelisted: true });
  }

  it('accepts a well-formed checkout payload', async () => {
    expect(await errorsOf(validPayload())).toHaveLength(0);
  });

  it('accepts an optional shipping complement', async () => {
    const errors = await errorsOf(
      validPayload({
        shippingAddress: {
          ...validPayload().shippingAddress,
          complement: 'Apto 42',
        },
      }),
    );
    expect(errors).toHaveLength(0);
  });

  it('rejects an empty items array', async () => {
    const errors = await errorsOf(validPayload({ items: [] }));
    expect(errors.some((error) => error.property === 'items')).toBe(true);
  });

  it(`rejects more than ${MAX_CHECKOUT_ITEMS} items`, async () => {
    const items = Array.from({ length: MAX_CHECKOUT_ITEMS + 1 }, () => ({
      productId: PRODUCT_ID,
      variantId: VARIANT_ID,
      quantity: 1,
    }));
    const errors = await errorsOf(validPayload({ items }));
    expect(errors.some((error) => error.property === 'items')).toBe(true);
  });

  it('rejects a non-uuid productId', async () => {
    const errors = await errorsOf(
      validPayload({
        items: [{ productId: 'not-a-uuid', variantId: VARIANT_ID, quantity: 1 }],
      }),
    );
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects a non-uuid variantId', async () => {
    const errors = await errorsOf(
      validPayload({
        items: [{ productId: PRODUCT_ID, variantId: 'not-a-uuid', quantity: 1 }],
      }),
    );
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects a zero quantity', async () => {
    const errors = await errorsOf(
      validPayload({
        items: [{ productId: PRODUCT_ID, variantId: VARIANT_ID, quantity: 0 }],
      }),
    );
    expect(errors.length).toBeGreaterThan(0);
  });

  it(`rejects a quantity above ${MAX_ITEM_QUANTITY}`, async () => {
    const errors = await errorsOf(
      validPayload({
        items: [
          {
            productId: PRODUCT_ID,
            variantId: VARIANT_ID,
            quantity: MAX_ITEM_QUANTITY + 1,
          },
        ],
      }),
    );
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects a non-integer quantity', async () => {
    const errors = await errorsOf(
      validPayload({
        items: [{ productId: PRODUCT_ID, variantId: VARIANT_ID, quantity: 1.5 }],
      }),
    );
    expect(errors.length).toBeGreaterThan(0);
  });

  describe('shippingAddress', () => {
    it('rejects a missing shippingAddress', async () => {
      const { shippingAddress: _omitted, ...withoutAddress } = validPayload();
      const errors = await errorsOf(withoutAddress);
      expect(errors.length).toBeGreaterThan(0);
    });

    it.each(['recipient', 'street', 'number', 'neighborhood', 'city', 'state', 'postalCode'])(
      'rejects a whitespace-only %s',
      async (field) => {
        const errors = await errorsOf(
          validPayload({
            shippingAddress: { ...validPayload().shippingAddress, [field]: '   ' },
          }),
        );
        expect(errors.length).toBeGreaterThan(0);
      },
    );

    it('rejects a state code longer than two letters', async () => {
      const errors = await errorsOf(
        validPayload({
          shippingAddress: { ...validPayload().shippingAddress, state: 'SPX' },
        }),
      );
      expect(errors.length).toBeGreaterThan(0);
    });
  });

  it('rejects unknown top-level fields such as a client-supplied totalCents', async () => {
    const errors = await errorsOf(validPayload({ totalCents: 100 }));
    expect(errors.length).toBeGreaterThan(0);
  });
});
