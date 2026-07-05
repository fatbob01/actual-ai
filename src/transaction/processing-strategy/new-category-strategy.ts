import { CategoryEntity, TransactionEntity } from '@actual-app/core/src/types/models';
import type {
  ProcessingStrategyI, UnifiedResponse,
} from '../../types';
import { isFeatureEnabled } from '../../config';

class NewCategoryStrategy implements ProcessingStrategyI {
  public isSatisfiedBy(response: UnifiedResponse): boolean {
    if (response.newCategory === undefined) {
      return false;
    }
    if (!isFeatureEnabled('suggestNewCategories')) {
      // The prompt is only supposed to offer "new" when this feature is on, but LLMs
      // don't always follow instructions. Claiming this response here when the feature
      // is off would silently drop it: CategorySuggester.suggest() (which actually
      // creates the category and updates the transaction) is gated on the same flag in
      // TransactionService, so nothing would ever act on it. Reject it instead so the
      // transaction falls through to the "unexpected response" handling and gets
      // tagged not-guessed rather than silently retried forever.
      return false;
    }
    return response.type === 'new';
  }

  public async process(
    transaction: TransactionEntity,
    response: UnifiedResponse,
    categories: CategoryEntity[],
    suggestedCategories: Map<string, {
        name: string;
        groupName: string;
        groupIsNew: boolean;
        groupId?: string;
        transactions: TransactionEntity[];
      }>,
  ) {
    if (response.newCategory === undefined) {
      throw new Error('No newCategory in response');
    }
    const categoryKey = `${response.newCategory.groupName}:${response.newCategory.name}`;

    const existing = suggestedCategories.get(categoryKey);
    if (existing) {
      existing.transactions.push(transaction);
    } else {
      suggestedCategories.set(categoryKey, {
        ...response.newCategory,
        transactions: [transaction],
      });
    }
    return Promise.resolve();
  }
}

export default NewCategoryStrategy;
