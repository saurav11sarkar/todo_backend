/*
  Warnings:

  - You are about to drop the column `describtion` on the `todos` table. All the data in the column will be lost.
  - You are about to drop the column `createAt` on the `users` table. All the data in the column will be lost.
  - You are about to drop the column `updateAt` on the `users` table. All the data in the column will be lost.
  - Added the required column `description` to the `todos` table without a default value. This is not possible if the table is not empty.
  - Added the required column `userId` to the `todos` table without a default value. This is not possible if the table is not empty.
  - Added the required column `updatedAt` to the `users` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "todos" DROP COLUMN "describtion",
ADD COLUMN     "completedAt" TIMESTAMP(3),
ADD COLUMN     "deadline" TIMESTAMP(3),
ADD COLUMN     "description" TEXT NOT NULL,
ADD COLUMN     "userId" TEXT NOT NULL,
ADD COLUMN     "whatsappNotified" BOOLEAN NOT NULL DEFAULT false,
ALTER COLUMN "isComplete" SET DEFAULT false;

-- AlterTable
ALTER TABLE "users" DROP COLUMN "createAt",
DROP COLUMN "updateAt",
ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "otp" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "otpExpires" TIMESTAMP(3),
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "verifiedForget" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "whatsappNumber" TEXT;

-- AddForeignKey
ALTER TABLE "todos" ADD CONSTRAINT "todos_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
