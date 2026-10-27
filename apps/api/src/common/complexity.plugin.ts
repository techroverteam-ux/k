import type { ApolloServerPlugin } from '@apollo/server';
import { GraphQLError } from 'graphql';
import { fieldExtensionsEstimator, getComplexity, simpleEstimator } from 'graphql-query-complexity';

/**
 * Rejects queries whose estimated cost is too high (protects against expensive nested/batched queries).
 * List fields with a `limit` argument are weighted by that limit.
 */
export function complexityPlugin(max: () => number): ApolloServerPlugin {
  return {
    async requestDidStart() {
      return {
        async didResolveOperation({ request, document, schema }) {
          const complexity = getComplexity({
            schema,
            operationName: request.operationName,
            query: document,
            variables: request.variables,
            estimators: [
              fieldExtensionsEstimator(),
              ({ args, childComplexity }) => {
                const n = typeof args?.limit === 'number' ? Math.min(args.limit, 100) : undefined;
                return n ? 1 + childComplexity * Math.max(1, Math.ceil(n / 10)) : undefined;
              },
              simpleEstimator({ defaultComplexity: 1 }),
            ],
          });
          if (complexity > max()) {
            throw new GraphQLError(`Query is too complex (${complexity} > ${max()}).`, { extensions: { code: 'BAD_REQUEST' } });
          }
        },
      };
    },
  };
}
