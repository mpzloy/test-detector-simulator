import {PrismaClient} from '@prisma/client';
import {createHash} from 'node:crypto';

const prisma = new PrismaClient();
const hash = (s: string) => createHash('sha256').update(s).digest('hex');

async function main() {
  await prisma.device.upsert({
    where: {id: 'detector-001'},
    update: {},
    create: {id: 'detector-001', keyHash: hash('test-device-key')}
  });
  console.log('Demo device ready: ID=detector-001, key=test-device-key');
}

main().finally(() => prisma.$disconnect());
