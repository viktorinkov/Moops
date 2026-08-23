export const FIXTURE_NAME = "mooops-food-delivery-v1";
export const CATALOG_REVISION = "catalog-v1";
export const FIXED_ORDER_DATE = "2026-08-23T12:00:00.000Z";

export const DEMO_AUTH = Object.freeze({
  email: "demo@moops.local",
  password: "moops-demo",
  accessToken: "mooops-access-token-v1",
  refreshToken: "mooops-refresh-token-v1",
  expires: 900000,
});

export const LOGIN_CREDENTIALS = deepFreeze([
  { email: DEMO_AUTH.email, password: DEMO_AUTH.password },
  { email: "spencer@gmail.com", password: "directus" },
]);

export const USER = Object.freeze({
  id: "39c5986b-92c1-45f1-b832-83a6e445706a",
  first_name: "Spencer",
  last_name: "Demo",
  email: DEMO_AUTH.email,
  status: "active",
});

export const RESTAURANTS = deepFreeze([
  {
    id: 1,
    status: "published",
    date_created: "2023-10-15T19:19:45.433Z",
    name: "Mcdonald's",
    logo: "fc3923bf-f6b8-474b-b7d2-4c3d471f6b81",
    rating: 4,
    description: "Burgers, sandwiches, and salads.",
    cover_image: "66bac81a-ed54-4696-8351-ba249c7785fa",
  },
  {
    id: 2,
    status: "published",
    date_created: "2023-10-16T09:11:42.786Z",
    name: "Wendy’s",
    logo: "de90ec31-7f59-4190-80af-637f5d2b1e45",
    rating: 4.5,
    description: "Burgers and pizza made to order.",
    cover_image: "bee85be3-0fd5-4e0e-939b-c7bb8b7ed496",
  },
]);

export const FOODS = deepFreeze([
  {
    id: 1,
    status: "published",
    date_created: "2023-10-15T18:39:46.111Z",
    name: "Cheese Burger",
    price: 4,
    price_cents: 400,
    currency: "$",
    short_description: "Cheesy Heaven",
    is_liked: true,
    image: "c036980b-67ec-43be-a3ec-2c78affa6ea3",
    category: 2,
    restaurant: 2,
    modifier_groups: [
      {
        id: "size",
        name: "Size",
        min_selections: 1,
        max_selections: 1,
        options: [
          { id: "regular", name: "Regular", price_delta_cents: 0 },
          { id: "large", name: "Large", price_delta_cents: 200 },
        ],
      },
      {
        id: "onions",
        name: "Onions",
        min_selections: 1,
        max_selections: 1,
        options: [
          { id: "onions", name: "Onions", price_delta_cents: 0 },
          { id: "no-onions", name: "No onions", price_delta_cents: 0 },
        ],
      },
    ],
  },
  {
    id: 2,
    status: "published",
    date_created: "2023-10-15T18:52:45.384Z",
    name: "Chicken Sandwich",
    price: 3.59,
    price_cents: 359,
    currency: "$",
    short_description: "Crispy Chicken",
    is_liked: true,
    image: "effa78ee-6710-418a-bae4-309e6e191ae8",
    category: 2,
    restaurant: 1,
    modifier_groups: [],
  },
  {
    id: 3,
    status: "published",
    date_created: "2023-10-16T09:06:52.000Z",
    name: "Pizza",
    price: 12.45,
    price_cents: 1245,
    currency: "$",
    short_description: "Grill Bar",
    is_liked: false,
    image: "c9901f01-1efe-4dfb-8262-43a5151a6988",
    category: 2,
    restaurant: 2,
    modifier_groups: [
      {
        id: "crust",
        name: "Crust",
        min_selections: 1,
        max_selections: 1,
        options: [
          { id: "thin", name: "Thin", price_delta_cents: 0 },
          { id: "deep-dish", name: "Deep dish", price_delta_cents: 250 },
        ],
      },
    ],
  },
  {
    id: 4,
    status: "published",
    date_created: "2023-10-16T09:07:43.467Z",
    name: "Salad",
    price: 13.29,
    price_cents: 1329,
    currency: "$",
    short_description: "Garden Fresh",
    is_liked: true,
    image: "ab50407e-33ee-4dda-b22b-b79b3ec6b23a",
    category: 3,
    restaurant: 1,
    modifier_groups: [],
  },
]);

export const CATEGORIES = deepFreeze([
  {
    id: 1,
    date_created: "2023-10-15T17:44:25.000Z",
    name: "Desserts",
    image: "4e0d45c7-a84f-4eed-b3e1-6580f7ef7c6d",
  },
  {
    id: 2,
    date_created: "2023-10-15T19:12:41.000Z",
    name: "Meat",
    image: "1f40cdea-479b-43f0-b409-2738a64bbdb6",
  },
  {
    id: 3,
    date_created: "2023-10-16T09:02:35.000Z",
    name: "Fruits",
    image: "9b2f894f-6c4e-44fe-a608-1005a2d85eff",
  },
]);

export const TESTIMONIALS = deepFreeze([
  {
    id: 1,
    status: "published",
    date_created: "2023-10-15T19:20:05.048Z",
    restaurant: 1,
    author_name: "Ricky Martin",
    content: "The food is delicious and the service is excellent.",
    rating: 5,
    avatar: "eec78d0c-3d3a-4801-829a-60f73641e693",
  },
  {
    id: 2,
    status: "published",
    date_created: "2023-10-20T09:15:01.085Z",
    restaurant: 1,
    author_name: "Keelan Vasquez",
    content: "This place became a favorite after one brunch.",
    rating: 4,
    avatar: "0bcd5e8a-677a-4071-a927-aaa3c5676093",
  },
  {
    id: 3,
    status: "published",
    date_created: "2023-10-20T09:16:40.000Z",
    restaurant: 2,
    author_name: "Adem Bennett",
    content: "The food is consistently excellent.",
    rating: 5,
    avatar: "f126d44a-41cb-493b-a5dc-5e47f61ff00d",
  },
  {
    id: 4,
    status: "published",
    date_created: "2023-10-20T09:17:26.000Z",
    restaurant: 1,
    author_name: "Woody Mccoy",
    content: "Everything was exactly right.",
    rating: 5,
    avatar: "a7895ea8-0b6f-40b0-9dba-0a48b129336c",
  },
]);

export const ASSET_IDS = Object.freeze([
  ...RESTAURANTS.flatMap(({ logo, cover_image: coverImage }) => [logo, coverImage]),
  ...FOODS.map(({ image }) => image),
  ...CATEGORIES.map(({ image }) => image),
  ...TESTIMONIALS.map(({ avatar }) => avatar),
]);

export const PLACEHOLDER_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}
