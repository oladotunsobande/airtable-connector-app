import { UserModel } from './schemas/user.schema.js';
import type { IUserRepository, UserDocument } from './user.repository.interface.js';

export class MongoUserRepository implements IUserRepository {
  async upsert(user: UserDocument): Promise<UserDocument> {
    const doc = await UserModel.findOneAndUpdate(
      { airtableId: user.airtableId },
      { $set: user },
      { upsert: true, new: true },
    ).lean();

    if (!doc) throw new Error(`Upsert failed for user ${user.airtableId}`);
    return doc as UserDocument;
  }

  async upsertMany(users: UserDocument[]): Promise<void> {
    if (users.length === 0) return;

    const ops = users.map((u) => ({
      updateOne: {
        filter: { airtableId: u.airtableId },
        update: { $set: u },
        upsert: true,
      },
    }));

    await UserModel.bulkWrite(ops, { ordered: false });
  }

  async findById(airtableId: string): Promise<UserDocument | null> {
    const doc = await UserModel.findOne({ airtableId }).lean();
    return doc as UserDocument | null;
  }

  async findAll(): Promise<UserDocument[]> {
    const docs = await UserModel.find().lean();
    return docs as UserDocument[];
  }
}
