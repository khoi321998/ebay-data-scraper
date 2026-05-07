# eBay Product & Seller Scraper

**Scrape comprehensive eBay data including products, sellers, reviews, and store information with production-ready performance optimization.**

## What does eBay Product & Seller Scraper do?

This Apify Actor provides **high-performance scraping** of eBay listings and seller profiles. It extracts detailed product information, pricing, reviews, seller feedback, and store data using optimized Cheerio and Playwright crawlers for maximum speed and reliability.

**Key features:**
- ⚡ **10x faster performance** with CheerioCrawler for static content
- 🎯 **Three scraping modes**: Product only, Seller only, or Product with Seller
- 🔄 **Anti-bot protection** with residential proxies
- 📊 **Structured JSON output** ready for analysis
- 🛡️ **Production-ready** with retry strategies and graceful error handling

## Why use eBay Product & Seller Scraper?

- **Comprehensive data extraction**: Get product details, pricing, reviews, seller reputation, and store inventory
- **Flexible modes**: Choose exactly what data you need - products, sellers, or both
- **High performance**: Optimized crawler architecture delivers fast, reliable results
- **Apify platform benefits**: API access, scheduling, integrations, proxy rotation, monitoring
- **Cost effective**: Residential proxies and smart concurrency reduce blocking and costs

## How to use eBay Product & Seller Scraper

1. **Choose your scraping mode**:
   - `product_only`: Scrape product details and reviews only
   - `seller_only`: Scrape seller profiles and feedback only
   - `product_with_seller`: Get complete product and seller data

2. **Provide start URLs**:
   - For product modes: Use eBay item URLs (e.g., `https://www.ebay.com/itm/123456789`)
   - For seller mode: Use seller store URLs (e.g., `https://www.ebay.com/usr/sellername`)

3. **Configure settings**:
   - Set maximum requests per crawl
   - Choose proxy configuration for anti-bot protection

4. **Run the Actor** and get structured JSON data with all product and seller information

## Input

The Actor accepts the following input parameters:

- **mode**: Scraping mode (`product_only`, `seller_only`, `product_with_seller`)
- **startUrls**: Array of URLs to start scraping from
- **maxRequestsPerCrawl**: Maximum number of pages to scrape (default: 1000)
- **proxyConfiguration**: Proxy settings for anti-bot protection

## Output

The Actor outputs structured JSON objects containing:

- **Product data**: Title, brand, pricing, stock, condition, shipping, specifications, reviews
- **Seller data**: Profile info, feedback scores, store items, reviews, business details
- **Technical data**: Tracking IDs, page context, API endpoints

### Sample Output

```json
{
  "platform": "ebay",
  "url": "https://www.ebay.com/itm/123456789",
  "capturedAt": "2024-01-15T10:30:00.000Z",
  "captureMode": "product_with_seller",
  "product": {
    "title": "Sample Product Title",
    "brand": "Brand Name",
    "pricing": {
      "currency": "USD",
      "price": 29.99,
      "priceMin": 29.99,
      "priceMax": 29.99
    },
    "stock": {
      "availableQuantity": 10,
      "soldCount": 5
    },
    "reviewsSummary": {
      "rating": 4.5,
      "reviewCount": 25,
      "negativeReviewSamples": [...],
      "positiveReviewSamples": [...]
    }
  },
  "seller": {
    "displayName": "Seller Name",
    "ebayUsername": "sellerusername",
    "feedbackScore": 1250,
    "positivePercent": 98.5,
    "storeItems": [...]
  }
}
```

## Data Table

| Field | Description | Type |
|-------|-------------|------|
| platform | Platform identifier | string |
| url | Original URL | string |
| capturedAt | Timestamp of capture | date |
| product.title | Product title | string |
| product.brand | Product brand | string |
| product.pricing.price | Current price | number |
| product.stock.availableQuantity | Available stock | number |
| product.reviewsSummary.rating | Average rating | number |
| seller.displayName | Seller display name | string |
| seller.feedbackScore | Seller feedback score | number |
| seller.positivePercent | Positive feedback percentage | number |

## Pricing / Cost Estimation

**Free tier**: 1,000 page requests per month
**Paid plans**: $0.50 per 1,000 page requests

**Cost factors**:
- Number of products/sellers scraped
- Review depth (more reviews = more requests)
- Proxy usage for anti-bot protection

**Example**: Scraping 100 products with seller data ≈ $0.75

## Tips for Optimal Performance

- Use `product_only` mode if you don't need seller data to reduce requests
- Set appropriate `maxRequestsPerCrawl` to control costs
- Enable residential proxies for large-scale scraping
- Monitor Apify Console for request success rates

## Limitations & Disclaimers

- Respects eBay's robots.txt and Terms of Service
- Includes rate limiting and delays to prevent overloading
- Does not scrape prohibited content or personal data
- Results may vary based on eBay's page structure changes

## Support

For custom modifications, feature requests, or support, please create an issue in this repository or contact the developer.

**Built with Apify platform for reliable, scalable web scraping.**

- **[Apify SDK](https://docs.apify.com/sdk/js)** - toolkit for building [Actors](https://apify.com/actors)
- **[Crawlee](https://crawlee.dev/)** - web scraping and browser automation library
- **[Input schema](https://docs.apify.com/platform/actors/development/input-schema)** - define and easily validate a schema for your Actor's input
- **[Dataset](https://docs.apify.com/sdk/python/docs/concepts/storages#working-with-datasets)** - store structured data where each object stored has the same attributes
- **[Cheerio](https://cheerio.js.org/)** - a fast, flexible & elegant library for parsing and manipulating HTML and XML
- **[Proxy configuration](https://docs.apify.com/platform/proxy)** - rotate IP addresses to prevent blocking

## Resources

- [Quick Start](https://docs.apify.com/platform/actors/development/quick-start) guide for building your first Actor
- [Video tutorial](https://www.youtube.com/watch?v=yTRHomGg9uQ) on building a scraper using CheerioCrawler
- [Written tutorial](https://docs.apify.com/academy/web-scraping-for-beginners/challenge) on building a scraper using CheerioCrawler
- [Web scraping with Cheerio in 2023](https://blog.apify.com/web-scraping-with-cheerio/)
- How to [scrape a dynamic page](https://blog.apify.com/what-is-a-dynamic-page/) using Cheerio
- [Integration with Zapier](https://apify.com/integrations), Make, Google Drive and others
- [Video guide on getting data using Apify API](https://www.youtube.com/watch?v=ViYYDHSBAKM)

## Creating Actors with templates

[How to create Apify Actors with web scraping code templates](https://www.youtube.com/watch?v=u-i-Korzf8w)


## Getting started

For complete information [see this article](https://docs.apify.com/platform/actors/development#build-actor-at-apify-console). In short, you will:

1. Build the Actor
2. Run the Actor

## Pull the Actor for local development

If you would like to develop locally, you can pull the existing Actor from Apify console using Apify CLI:

1. Install `apify-cli`

    **Using Homebrew**

    ```bash
    brew install apify-cli
    ```

    **Using NPM**

    ```bash
    npm -g install apify-cli
    ```

2. Pull the Actor by its unique `<ActorId>`, which is one of the following:
    - unique name of the Actor to pull (e.g. "apify/hello-world")
    - or ID of the Actor to pull (e.g. "E2jjCZBezvAZnX8Rb")

    You can find both by clicking on the Actor title at the top of the page, which will open a modal containing both Actor unique name and Actor ID.

    This command will copy the Actor into the current directory on your local machine.

    ```bash
    apify pull <ActorId>
    ```

## Documentation reference

To learn more about Apify and Actors, take a look at the following resources:

- [Apify SDK for JavaScript documentation](https://docs.apify.com/sdk/js)
- [Apify SDK for Python documentation](https://docs.apify.com/sdk/python)
- [Apify Platform documentation](https://docs.apify.com/platform)
- [Join our developer community on Discord](https://discord.com/invite/jyEM2PRvMU)
