import NewCategoryStrategy from '../src/transaction/processing-strategy/new-category-strategy';
import GivenActualData from './test-doubles/given/given-actual-data';
import * as config from '../src/config';

describe('NewCategoryStrategy', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('isSatisfiedBy', () => {
    it('matches a "new" response with newCategory when suggestNewCategories is enabled', () => {
      jest.spyOn(config, 'isFeatureEnabled').mockReturnValue(true);
      const strategy = new NewCategoryStrategy();

      expect(strategy.isSatisfiedBy({
        type: 'new',
        newCategory: { name: 'Pet Supplies', groupName: 'Pets', groupIsNew: true },
      })).toBe(true);
    });

    it('rejects a "new" response when suggestNewCategories is disabled, even though the LLM sent one', () => {
      // The prompt is only supposed to offer "new" when the feature is on, but the LLM
      // doesn't always follow instructions. If this strategy claimed the response
      // anyway, CategorySuggester.suggest() (gated on the same flag) would never act on
      // it, silently dropping the transaction instead of falling through to the
      // not-guessed path.
      jest.spyOn(config, 'isFeatureEnabled').mockReturnValue(false);
      const strategy = new NewCategoryStrategy();

      expect(strategy.isSatisfiedBy({
        type: 'new',
        newCategory: { name: 'Pet Supplies', groupName: 'Pets', groupIsNew: true },
      })).toBe(false);
    });

    it('rejects a response without newCategory regardless of the feature flag', () => {
      jest.spyOn(config, 'isFeatureEnabled').mockReturnValue(true);
      const strategy = new NewCategoryStrategy();

      expect(strategy.isSatisfiedBy({ type: 'new' })).toBe(false);
    });

    it('rejects non-"new" responses even with newCategory present', () => {
      jest.spyOn(config, 'isFeatureEnabled').mockReturnValue(true);
      const strategy = new NewCategoryStrategy();

      expect(strategy.isSatisfiedBy({
        type: 'existing',
        categoryId: 'cat-1',
        newCategory: { name: 'Pet Supplies', groupName: 'Pets', groupIsNew: true },
      })).toBe(false);
    });
  });

  describe('process', () => {
    it('buffers the transaction under a key combining group and category name', async () => {
      jest.spyOn(config, 'isFeatureEnabled').mockReturnValue(true);
      const strategy = new NewCategoryStrategy();
      const suggestedCategories = new Map<string, {
        name: string;
        groupName: string;
        groupIsNew: boolean;
        groupId?: string;
        transactions: ReturnType<typeof GivenActualData.createTransaction>[];
      }>();
      const transaction = GivenActualData.createTransaction('1', -123, 'Pet Store');

      await strategy.process(
        transaction,
        { type: 'new', newCategory: { name: 'Pet Supplies', groupName: 'Pets', groupIsNew: true } },
        [],
        suggestedCategories,
      );

      expect(suggestedCategories.get('Pets:Pet Supplies')?.transactions).toEqual([transaction]);
    });
  });
});
