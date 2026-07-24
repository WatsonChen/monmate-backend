import {
  CheckInStatus,
  PaymentProduct,
  PaymentStatus,
  PrismaClient,
  UserRole
} from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  const passwordHash = await bcrypt.hash("123456", 10);

  const testUsers = [
    {
      name: "abby",
      email: "abby@monmate.local",
      role: UserRole.OWNER,
      attendeeCredits: 3
    },
    {
      name: "watson",
      email: "watson@monmate.local",
      role: UserRole.ADMIN,
      attendeeCredits: 3
    },
    {
      name: "現場工作人員",
      email: "staff@monmate.local",
      role: UserRole.STAFF,
      attendeeCredits: 0
    }
  ];

  const users = await Promise.all(
    testUsers.map((user) =>
      prisma.user.upsert({
        where: { email: user.email },
        update: {
          name: user.name,
          passwordHash,
          role: user.role
        },
        create: {
          ...user,
          passwordHash
        }
      })
    )
  );

  const owner = users[0];

  await Promise.all(
    users.flatMap((user) => {
      const creditCount =
        testUsers.find((testUser) => testUser.email === user.email)
          ?.attendeeCredits ?? 0;

      return Array.from({ length: creditCount }, (_, index) =>
        prisma.payment.upsert({
          where: {
            providerOrderNo: `SEED-${user.email}-${index + 1}`
          },
          update: {},
          create: {
            userId: user.id,
            provider: "seed",
            product: PaymentProduct.EVENT_CREDIT,
            status: PaymentStatus.PAID,
            quantity: 1,
            creditsGranted: 1,
            amountTotal: 0,
            currency: "TWD",
            pricingTier: "SEED",
            attendeeLimit: 999,
            providerOrderNo: `SEED-${user.email}-${index + 1}`,
            paidAt: new Date()
          }
        })
      );
    })
  );

  const event = await prisma.event.upsert({
    where: { slug: "monmate-demo" },
    update: {
      name: "MonMate Demo 活動",
      description: "MVP 測試活動",
      startAt: new Date(),
      location: "台北市",
      createdById: owner.id
    },
    create: {
      name: "MonMate Demo 活動",
      slug: "monmate-demo",
      description: "MVP 測試活動",
      startAt: new Date(),
      location: "台北市",
      createdById: owner.id
    }
  });

  const now = new Date();

  // Each attendee is pinned to a fixed demo state on every seed run —
  // not just created once — so the public checkin demo reliably shows a
  // specific outcome per phone number:
  //   0912345678 王小明：報到成功（同時被 check-in.service 特例重置，可無限重播）
  //   0987654321 陳美玲：已完成報到
  //   0933222111 林志強：超過報到人數（攜伴 2 人，已全數報到）
  //   0966888999 / 0900000000：備用，維持未報到
  const testAttendees = [
    {
      name: "王小明",
      phone: "0912345678",
      checkInCode: "MM0001",
      qrToken: "demo-qr-token-1",
      checkInCapacity: 1,
      checkInCount: 0,
      checkInStatus: CheckInStatus.NOT_CHECKED_IN,
      checkedInAt: null as Date | null
    },
    {
      name: "陳美玲",
      phone: "0987654321",
      checkInCode: "MM0002",
      qrToken: "demo-qr-token-2",
      checkInCapacity: 1,
      checkInCount: 1,
      checkInStatus: CheckInStatus.CHECKED_IN,
      checkedInAt: now
    },
    {
      name: "林志強",
      phone: "0933222111",
      checkInCode: "MM0003",
      qrToken: "demo-qr-token-3",
      checkInCapacity: 2,
      checkInCount: 2,
      checkInStatus: CheckInStatus.CHECKED_IN,
      checkedInAt: now
    },
    {
      name: "張雅婷",
      phone: "0966888999",
      checkInCode: "MM0004",
      qrToken: "demo-qr-token-4",
      checkInCapacity: 1,
      checkInCount: 0,
      checkInStatus: CheckInStatus.NOT_CHECKED_IN,
      checkedInAt: null as Date | null
    },
    {
      name: "測試來賓",
      phone: "0900000000",
      checkInCode: "MM0005",
      qrToken: "demo-qr-token-5",
      checkInCapacity: 1,
      checkInCount: 0,
      checkInStatus: CheckInStatus.NOT_CHECKED_IN,
      checkedInAt: null as Date | null
    }
  ];

  await Promise.all(
    testAttendees.map((attendee) =>
      prisma.attendee.upsert({
        where: {
          eventId_checkInCode: {
            eventId: event.id,
            checkInCode: attendee.checkInCode
          }
        },
        update: attendee,
        create: {
          ...attendee,
          eventId: event.id
        }
      })
    )
  );

  await prisma.checkInLog.deleteMany({
    where: { eventId: event.id }
  });

  const attendees = await prisma.attendee.findMany({
    where: { eventId: event.id },
    orderBy: { checkInCode: "asc" }
  });

  console.log("MonMate seed completed.");
  console.log("Test accounts:");
  for (const user of users) {
    console.log(
      `- ${user.role}: ${user.email} / 123456 | credits=${user.attendeeCredits}`
    );
  }
  console.log(`Event ID: ${event.id}`);
  for (const attendee of attendees) {
    console.log(
      `Attendee: ${attendee.name} | manual=${attendee.checkInCode} | qr=${attendee.qrToken}`
    );
  }
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
