import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

// Also: stripe-payments, stripe-subscriptions, calcom-bookings, woocommerce-orders, tickettailor-tickets, custom.
const guide = await pb.connectors.recipeSetup.retrieve('shopify-orders');
console.log(guide.steps.map((s) => s.title));
