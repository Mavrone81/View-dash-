/*
  Warnings:

  - You are about to drop the column `secretSealed` on the `AgentEnrolment` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "AgentEnrolment" DROP COLUMN "secretSealed";
