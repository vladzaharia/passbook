/**
 * Test helper: the field shapes of Google's REST bodies, written from google-wallet.md section 1
 * and the REST reference. Strict, so a compiler cannot add a key the API does not know, and a
 * required field cannot go missing.
 */
import { z } from 'zod';

const translated = z.strictObject({ language: z.string().min(2), value: z.string() });
const localized = z.strictObject({
  defaultValue: translated,
  translatedValues: z.array(translated).min(1).optional(),
});
const image = z.strictObject({
  sourceUri: z.strictObject({ uri: z.string().regex(/^https:\/\/\S+$/u) }),
  contentDescription: localized,
});
const textModule = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9._-]+$/u),
  header: z.string().optional(),
  body: z.string(),
  localizedHeader: localized.optional(),
  localizedBody: localized.optional(),
});
const linksModule = z.strictObject({
  uris: z
    .array(
      z.strictObject({
        id: z.string(),
        uri: z.string().regex(/^(?:https:|tel:|mailto:)\S+$/u),
        description: z.string().min(1),
      }),
    )
    .max(10),
});
const imageModule = z.strictObject({ id: z.string(), mainImage: image });
const dateTime = z.strictObject({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u),
});
const latLong = z.strictObject({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});
const money = z.strictObject({
  micros: z.string().regex(/^-?\d+$/u),
  currencyCode: z.string().length(3),
});
const rfc3339 = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$/u);
const points = z.strictObject({
  label: z.string(),
  balance: z.union([
    z.strictObject({ int: z.number().int() }),
    z.strictObject({ double: z.number() }),
    z.strictObject({ string: z.string() }),
    z.strictObject({ money }),
  ]),
});

const objectCommon = {
  state: z.enum(['ACTIVE', 'INACTIVE']),
  barcode: z
    .strictObject({
      type: z.enum(['QR_CODE', 'PDF_417', 'AZTEC', 'CODE_128', 'CODE_39']),
      renderEncoding: z.literal('UTF_8'),
      value: z.string().min(1),
      alternateText: z.string().optional(),
    })
    .optional(),
  validTimeInterval: z
    .strictObject({ start: dateTime.optional(), end: dateTime.optional() })
    .optional(),
  textModulesData: z.array(textModule).max(10).optional(),
  linksModuleData: linksModule.optional(),
  imageModulesData: z.array(imageModule).optional(),
  messages: z
    .array(
      z.strictObject({
        id: z.string(),
        header: z.string(),
        body: z.string(),
        messageType: z.enum(['TEXT', 'TEXT_AND_NOTIFY']),
      }),
    )
    .max(10)
    .optional(),
};
const classCommon = {
  multipleDevicesAndHoldersAllowedStatus: z.literal('ONE_USER_ALL_DEVICES'),
  hexBackgroundColor: z
    .string()
    .regex(/^#[0-9a-f]{6}$/u)
    .optional(),
  heroImage: image.optional(),
};
const typedClass = {
  ...classCommon,
  issuerName: z.string().min(1),
  reviewStatus: z.literal('UNDER_REVIEW'),
};
const locations = z.array(latLong).max(10).optional();

export const GOOGLE_SHAPES = {
  generic: {
    classBody: z.strictObject({
      multipleDevicesAndHoldersAllowedStatus: classCommon.multipleDevicesAndHoldersAllowedStatus,
    }),
    objectBody: z.strictObject({
      ...objectCommon,
      genericType: z.literal('GENERIC_OTHER'),
      cardTitle: localized,
      header: localized,
      subheader: localized.optional(),
      logo: image.optional(),
      wideLogo: image.optional(),
      heroImage: image.optional(),
      hexBackgroundColor: classCommon.hexBackgroundColor,
      merchantLocations: locations,
      notifications: z
        .strictObject({
          upcomingNotification: z.strictObject({ enableNotification: z.literal(true) }),
        })
        .optional(),
    }),
  },
  event: {
    classBody: z.strictObject({
      ...typedClass,
      eventName: localized,
      venue: z
        .strictObject({ name: localized.optional(), address: localized.optional() })
        .optional(),
      dateTime: z
        .strictObject({
          start: rfc3339.optional(),
          end: rfc3339.optional(),
          doorsOpen: rfc3339.optional(),
        })
        .optional(),
      eventId: z.string().optional(),
      logo: image.optional(),
      wideLogo: image.optional(),
    }),
    objectBody: z.strictObject({
      ...objectCommon,
      ticketHolderName: z.string().optional(),
      ticketNumber: z.string().optional(),
      reservationInfo: z.strictObject({ confirmationCode: z.string() }).optional(),
      seatInfo: z
        .strictObject({
          seat: localized.optional(),
          row: localized.optional(),
          section: localized.optional(),
          gate: localized.optional(),
        })
        .optional(),
      locations,
    }),
  },
  loyalty: {
    classBody: z.strictObject({
      ...typedClass,
      programName: z.string().min(1),
      programLogo: image,
      wideProgramLogo: image.optional(),
      accountIdLabel: z.string().optional(),
      accountNameLabel: z.string().optional(),
    }),
    objectBody: z.strictObject({
      ...objectCommon,
      accountId: z.string().optional(),
      accountName: z.string().optional(),
      loyaltyPoints: points.optional(),
      secondaryLoyaltyPoints: points.optional(),
      locations,
    }),
  },
  gift: {
    classBody: z.strictObject({
      ...typedClass,
      merchantName: z.string().min(1),
      programLogo: image,
      wideProgramLogo: image.optional(),
      cardNumberLabel: z.string().optional(),
      pinLabel: z.string().optional(),
      balanceLabel: z.string().optional(),
    }),
    objectBody: z.strictObject({
      ...objectCommon,
      cardNumber: z.string().min(1),
      pin: z.string().optional(),
      balance: money.optional(),
      locations,
    }),
  },
  offer: {
    classBody: z.strictObject({
      ...typedClass,
      provider: z.string().min(1),
      title: z.string().min(1),
      localizedTitle: localized.optional(),
      redemptionChannel: z.enum(['ONLINE', 'INSTORE', 'BOTH']),
      details: z.string().optional(),
      localizedDetails: localized.optional(),
      finePrint: z.string().optional(),
      localizedFinePrint: localized.optional(),
      titleImage: image.optional(),
      wideTitleImage: image.optional(),
    }),
    objectBody: z.strictObject({ ...objectCommon, locations }),
  },
} as const;
