import { VOCAB } from '../constants/snippets';
import type { SeedingProgress } from '../types/studio';

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomFloat(min: number, max: number, decimals = 2): number {
  const val = min + Math.random() * (max - min);
  return parseFloat(val.toFixed(decimals));
}

function randomInt(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min + 1));
}

function randomPastDate(daysAgoMax = 90): string {
  const d = new Date();
  d.setDate(d.getDate() - randomInt(0, daysAgoMax));
  return d.toISOString().split('T')[0];
}

export async function seedDatabaseTemplate(
  db: any,
  dbName: string,
  templateKey: string,
  onProgress: (p: SeedingProgress) => void,
): Promise<void> {
  if (!db || templateKey === 'empty') return;

  onProgress({
    visible: true,
    title: `Seeding ${dbName}...`,
    step: 'Defining tables schema...',
    current: 0,
    total: 100,
  });

  const tablesSchema = [
    {
      name: 'categories',
      cols: [
        { name: 'id', type: 'INT32', flags: { primaryKey: true, notNull: true } },
        { name: 'name', type: 'TEXT', flags: { notNull: true } },
        { name: 'department', type: 'TEXT' },
        { name: 'item_count', type: 'INT32' },
      ],
    },
    {
      name: 'products',
      cols: [
        { name: 'id', type: 'INT32', flags: { primaryKey: true, notNull: true } },
        { name: 'category_id', type: 'INT32', flags: { notNull: true } },
        { name: 'title', type: 'TEXT', flags: { notNull: true } },
        { name: 'brand', type: 'TEXT' },
        { name: 'price', type: 'FLOAT64' },
        { name: 'cost', type: 'FLOAT64' },
        { name: 'stock', type: 'INT32' },
        { name: 'rating', type: 'FLOAT64' },
      ],
    },
    {
      name: 'customers',
      cols: [
        { name: 'id', type: 'INT32', flags: { primaryKey: true, notNull: true } },
        { name: 'name', type: 'TEXT', flags: { notNull: true } },
        { name: 'email', type: 'TEXT' },
        { name: 'country', type: 'TEXT' },
        { name: 'tier', type: 'TEXT' },
        { name: 'lifetime_spent', type: 'FLOAT64' },
      ],
    },
    {
      name: 'orders',
      cols: [
        { name: 'id', type: 'INT32', flags: { primaryKey: true, notNull: true } },
        { name: 'customer_id', type: 'INT32', flags: { notNull: true } },
        { name: 'status', type: 'TEXT' },
        { name: 'order_date', type: 'TEXT' },
        { name: 'total_amount', type: 'FLOAT64' },
        { name: 'tax', type: 'FLOAT64' },
        { name: 'shipping_cost', type: 'FLOAT64' },
        { name: 'items_count', type: 'INT32' },
      ],
    },
    {
      name: 'reviews',
      cols: [
        { name: 'id', type: 'INT32', flags: { primaryKey: true, notNull: true } },
        { name: 'product_id', type: 'INT32', flags: { notNull: true } },
        { name: 'customer_id', type: 'INT32', flags: { notNull: true } },
        { name: 'rating', type: 'INT32' },
        { name: 'verified_purchase', type: 'INT32' },
        { name: 'headline', type: 'TEXT' },
      ],
    },
  ];

  for (const tbl of tablesSchema) {
    try {
      await db.createTable(tbl.name, tbl.cols);
    } catch {}
  }

  let countProducts = 500;
  let countCustomers = 250;
  let countOrders = 500;
  let countReviews = 250;
  let useRealApi = false;

  if (templateKey === 'store_large') {
    countProducts = 4000;
    countCustomers = 2000;
    countOrders = 3000;
    countReviews = 1000;
  } else if (templateKey === 'store_real_api') {
    useRealApi = true;
    countCustomers = 100;
    countOrders = 200;
    countReviews = 150;
  }

  const totalItems = 5 + countProducts + countCustomers + countOrders + countReviews;
  let inserted = 0;

  const update = (step: string) => {
    onProgress({
      visible: true,
      title: `Seeding ${dbName}...`,
      step,
      current: inserted,
      total: totalItems,
    });
  };

  // 1. Categories
  const categoriesData = [
    { id: 1, name: 'Audio & Acoustics', department: 'Electronics', item_count: 0 },
    { id: 2, name: 'Computers & Laptops', department: 'Computers', item_count: 0 },
    { id: 3, name: 'Mobile & Accessories', department: 'Mobile', item_count: 0 },
    { id: 4, name: 'Gaming Gear', department: 'Gaming', item_count: 0 },
    { id: 5, name: 'Workspace & Office', department: 'Office', item_count: 0 },
  ];
  for (const cat of categoriesData) {
    try {
      await db.insert('categories', cat);
    } catch {}
    inserted++;
  }
  update('Seeding Categories...');

  // 2. Products
  if (useRealApi) {
    update('Fetching live products (DummyJSON)...');
    try {
      const res = await fetch('https://dummyjson.com/products?limit=100');
      const data = await res.json();
      const realProducts = data.products || [];
      countProducts = realProducts.length;

      for (let i = 0; i < realProducts.length; i++) {
        const p = realProducts[i];
        try {
          await db.insert('products', {
            id: p.id,
            category_id: (i % 5) + 1,
            title: p.title,
            brand: p.brand || pickRandom(VOCAB.brands),
            price: parseFloat(Number(p.price).toFixed(2)),
            cost: parseFloat((Number(p.price) * 0.45).toFixed(2)),
            stock: p.stock || randomInt(5, 120),
            rating: parseFloat(Number(p.rating || 4.5).toFixed(2)),
          });
        } catch {}
        inserted++;
        if (i % 25 === 0) {
          update('Inserting Products...');
          await new Promise((r) => setTimeout(r, 0));
        }
      }
    } catch (err) {
      console.warn('API fetch failed, falling back to procedural:', err);
    }
  } else {
    for (let i = 1; i <= countProducts; i++) {
      const brand = pickRandom(VOCAB.brands);
      const adj = pickRandom(VOCAB.adjectives);
      const noun = pickRandom(VOCAB.nouns);
      const title = `${brand} ${adj} ${noun} ${randomInt(100, 990)}`;
      const price = randomFloat(19.99, 1299.99);
      const cost = randomFloat(price * 0.35, price * 0.6);
      const stock = randomInt(0, 180);
      const rating = randomFloat(2.5, 5.0, 1);
      const catId = (i % 5) + 1;

      try {
        await db.insert('products', {
          id: i,
          category_id: catId,
          title,
          brand,
          price,
          cost,
          stock,
          rating,
        });
      } catch {}
      inserted++;
      if (i % 200 === 0) {
        update('Inserting Products...');
        await new Promise((r) => setTimeout(r, 0));
      }
    }
  }

  // 3. Customers
  for (let i = 1; i <= countCustomers; i++) {
    const fn = pickRandom(VOCAB.firstNames);
    const ln = pickRandom(VOCAB.lastNames);
    const name = `${fn} ${ln}`;
    const email = `${fn.toLowerCase()}.${ln.toLowerCase()}${randomInt(1, 99)}@example.com`;
    const country = pickRandom(VOCAB.countries);
    const tier = pickRandom(VOCAB.customerTiers);
    const lifetime_spent = randomFloat(50.0, 4500.0);

    try {
      await db.insert('customers', {
        id: i,
        name,
        email,
        country,
        tier,
        lifetime_spent,
      });
    } catch {}
    inserted++;
    if (i % 200 === 0) {
      update('Inserting Customers...');
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  // 4. Orders
  for (let i = 1; i <= countOrders; i++) {
    const customer_id = randomInt(1, countCustomers);
    const status = pickRandom(VOCAB.orderStatuses);
    const order_date = randomPastDate(90);
    const total_amount = randomFloat(25.0, 1850.0);
    const tax = randomFloat(total_amount * 0.07, total_amount * 0.1);
    const shipping_cost = randomFloat(4.99, 29.99);
    const items_count = randomInt(1, 8);

    try {
      await db.insert('orders', {
        id: 1000 + i,
        customer_id,
        status,
        order_date,
        total_amount,
        tax,
        shipping_cost,
        items_count,
      });
    } catch {}
    inserted++;
    if (i % 200 === 0) {
      update('Inserting Orders...');
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  // 5. Reviews
  for (let i = 1; i <= countReviews; i++) {
    const product_id = randomInt(1, countProducts);
    const customer_id = randomInt(1, countCustomers);
    const rating = randomInt(1, 5);
    const verified_purchase = Math.random() > 0.3 ? 1 : 0;
    const headlines = [
      'Exceeded expectations!',
      'Great value for money.',
      'Average build quality.',
      'Absolute beast of a device.',
      'Battery lasts forever.',
      'Sleek and responsive.',
      'Would definitely buy again.',
      'Could be better packaged.',
    ];
    const headline = pickRandom(headlines);

    try {
      await db.insert('reviews', {
        id: 5000 + i,
        product_id,
        customer_id,
        rating,
        verified_purchase,
        headline,
      });
    } catch {}
    inserted++;
    if (i % 200 === 0) {
      update('Inserting Reviews...');
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  onProgress({
    visible: false,
    title: '',
    step: 'Done',
    current: totalItems,
    total: totalItems,
  });
}
