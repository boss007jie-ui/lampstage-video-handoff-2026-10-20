-- AlterTable
ALTER TABLE "User" ADD COLUMN     "email_verified" TIMESTAMP(3),
ADD COLUMN     "password_hash" TEXT;
