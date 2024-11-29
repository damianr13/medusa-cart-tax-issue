import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { MedusaContainer } from "@medusajs/framework/types"
import seedBase from "../../src/scripts/seed"
import { addToCartWorkflow, createCartWorkflow, createTaxRatesWorkflow } from "@medusajs/medusa/core-flows"
import { ContainerRegistrationKeys, remoteQueryObjectFromString } from "@medusajs/framework/utils"
import { Modules } from "@medusajs/framework/utils"
import { defaultStoreCartFields } from "@medusajs/medusa/api/store/carts/query-config"
import { logger } from "@medusajs/framework"

const cartFormattedFields = defaultStoreCartFields.map((f) => {
  if (f.startsWith("*")) {
    return f.slice(1) + ".*"
  }
  return f
})

async function seed(container: MedusaContainer) {
  const regionModuleService = container.resolve(Modules.REGION)
  const taxModuleService = container.resolve(Modules.TAX)

  // Create tax rates in all tax regions
  const taxRegions = await taxModuleService.listTaxRegions()
  await createTaxRatesWorkflow(container).run({
    input: taxRegions.map((taxRegion) => ({
      tax_region_id: taxRegion.id,
      name: taxRegion.country_code,
      code: taxRegion.country_code,
      rate: 10,
      is_default: true
    }))
  })

  const [defaultRegion] = await regionModuleService.listRegions({}, {
    relations: ["countries"]
  })

  await createCartWorkflow(container).run({
    input: {
      // @ts-ignore - the type checking from medusa does not allow ids but if we set them it works
      id: "example-cart",
      currency_code: "eur",
      region_id: defaultRegion.id,
      country_code: defaultRegion.countries[0].iso_2,
      shipping_address: {
        country_code: defaultRegion.countries[0].iso_2,
      }
    },
  })
  logger.info(`Cart created: example-cart`)
}

medusaIntegrationTestRunner({
  dbName: process.env.TEST_STATIC_DB_NAME,
  testSuite: async ({ getContainer }) => {
    beforeEach(async () => {
      await seedBase({ container: getContainer(), args: [] })
      await seed(getContainer())
    })
    describe("Test that adding items to cart calculates tax as expected", () => {
      test("should calculate tax with 2 items in the cart", async () => {
        const remoteQuery = getContainer().resolve(ContainerRegistrationKeys.REMOTE_QUERY)
        const query = getContainer().resolve(ContainerRegistrationKeys.QUERY)
        const taxService = getContainer().resolve(Modules.TAX)
        const pricingModuleService = getContainer().resolve(Modules.PRICING)
        const regionModuleService = getContainer().resolve(Modules.REGION)

        const [defaultRegion] = await regionModuleService.listRegions({}, {
          relations: ["countries"]
        })

        const queryObject = remoteQueryObjectFromString({
          entryPoint: "cart",
          variables: { filters: { id: "example-cart" } },
          fields: cartFormattedFields
        })

        const [cart] = await remoteQuery(queryObject)
        const products = await query.graph({
          entity: 'product',
          fields: ['id', 'title', 'variants.*', 'variants.id', 'variants.price_set.*'],
          filters: {
            title: ['Medusa T-Shirt', 'Medusa Shorts']
          }
        })

        const pricingContext = {
          context: {
            region_id: defaultRegion.id,
            currency_code: "eur",
            country_code: defaultRegion.countries[0].iso_2,
          }
        }

        const product1 = products.data[0]
        const product2 = products.data[1]

        const prices = await pricingModuleService.calculatePrices({
          id: [product1.variants[0].price_set!.id, product2.variants[0].price_set!.id],
        }, pricingContext)
        const priceForProduct1 = prices.find((p) => p.id === product1.variants[0].price_set!.id)
        const priceForProduct2 = prices.find((p) => p.id === product2.variants[0].price_set!.id)

        await addToCartWorkflow(getContainer()).run({
          input: {
            cart,
            items: [{
              variant_id: products.data[0].variants[0].id,
              quantity: 1,
            }]
          }
        })
        await addToCartWorkflow(getContainer()).run({
          input: {
            cart,
            items: [{
              variant_id: products.data[1].variants[0].id,
              quantity: 1,
            }]
          }
        })

        const taxLines = await taxService.getTaxLines([
          {
            id: products.data[0].variants[0].id,
            product_id: products.data[0].id,
            quantity: 1,
            unit_price: priceForProduct1!.calculated_amount ?? 0,
          },
          {
            id: products.data[1].variants[0].id,
            product_id: products.data[1].id,
            quantity: 1,
            unit_price: priceForProduct2!.calculated_amount ?? 0,
          }
        ], {
          address: {
            country_code: defaultRegion.countries[0].iso_2,
          }
        })
        expect(taxLines.length).toBe(2)

        const [updatedCart] = await remoteQuery(queryObject)
        expect(updatedCart.items.length).toBe(2)
        expect(updatedCart.items[0].tax_lines.length).toBe(1)
        expect(updatedCart.items[1].tax_lines.length).toBe(1)
      })
    })
  }
})