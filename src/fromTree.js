import { buildLabelValueObject, invert } from './commons';
import { LABEL_KEYS, MATCH_KEYS, OPERATOR_KEYS } from './constants';
import { InvalidInputError, UnsupportedRepresentationError } from './Errors';

/**
 * Validate the tree and extracts the main node.
 * @param {Object[]} tree - the tree
 * @return {{comment: {Text: String, Type: 'Comment'}, tree: {If: Object, Then: Array, Else: *, Type: String}}}
 */
function extractMainNode(tree) {
    if (Array.isArray(tree)) {
        const { mainNode, comment, errorLevel, requiredExtensions } = tree.reduce(
            (acc, node) => {
                if (node.Type === 'Require') {
                    let extensionIndex = acc.requiredExtensions.length;
                    while (extensionIndex--) {
                        const extension = acc.requiredExtensions[extensionIndex];
                        if (node.List.indexOf(extension) > -1) {
                            acc.requiredExtensions.splice(extensionIndex, 1);
                        }
                    }
                    return acc;
                }

                if (node.Type === 'If') {
                    // must have all these keys. All of them must be array (so none == false)
                    // the error will always be from the last node, which is totally expected from a simple generated tree.
                    acc.errorLevel = ['If', 'Then', 'Type'].find((key) => !node[key]);
                    if (!acc.errorLevel) {
                        if (!node.If.Tests) {
                            acc.errorLevel = 'Tests';
                            return acc;
                        }

                        acc.mainNode = node;
                    }
                    return acc;
                }

                if (
                    node.Type === 'Comment' &&
                    node.Text.match(/^\/\*\*\r\n(?:\s\*\s@(?:type|comparator)[^\r]+\r\n)+\s\*\/$/)
                ) {
                    acc.comment = node;
                    return acc;
                }
                return acc;
            },
            {
                requiredExtensions: ['fileinto', 'imap4flags']
            }
        );

        if (!mainNode) {
            throw new InvalidInputError(`Invalid tree representation: ${errorLevel} level`);
        }

        if (requiredExtensions.length) {
            throw new InvalidInputError('Invalid tree representation: requirements');
        }
        return { comment, tree: mainNode };
    }

    throw new UnsupportedRepresentationError('Array expected.');
}

/**
 * Parses the comparator comment, to retrieve the expected comparators.
 * @param {{Type: 'Comment', Text: String}} [comparator=] the comparator comment.
 * @return {{comparators: String[], type: String}|undefined}
 */
function parseComparatorComment(comparator) {
    if (!comparator) {
        return;
    }

    const text = comparator.Text;
    const chunks = text.split('\r\n *');

    const mapAnnotation = {
        and: 'all',
        or: 'any'
    };

    const ret = chunks.reduce(
        (acc, chunk) => {
            const res = chunk.match(/\s@(\w*)\s(.*)$/);
            if (res) {
                const [, annotationType, value] = res; // skipping first value

                if (annotationType === 'type') {
                    const val = mapAnnotation[value];

                    if (!val) {
                        acc.errors.push({ type: annotationType, value });
                        return acc;
                    }

                    acc.type = val;
                    return acc;
                }

                if (annotationType === 'comparator') {
                    acc.comparators.push(value.replace('default', 'contains'));
                    return acc;
                }
            }
            return acc;
        },
        { comparators: [], type: '', errors: [] }
    );

    if (ret.errors.length) {
        throw new InvalidInputError(
            `Unknown ${ret.errors.reduce((acc, { type, value }) => `${acc ? acc + ', ' : ''}${type} "${value}"`, '')}`
        );
    }
    return ret;
}

/**
 * Parse a specific comment annotation
 * @param {String=} commentComparator
 * @return {{negate: Boolean=, comparator: String=}}
 */
function prepareComment(commentComparator) {
    if (!commentComparator) {
        return {};
    }

    const negate = commentComparator.startsWith('!');
    return {
        negate,
        comparator: negate ? commentComparator.slice(1) : commentComparator
    };
}

/**
 * Prepares single condition.
 * @param {{Type: string, Test: *=}} element
 * @return {{negate: boolean, element: *}}
 */
function prepareSingleCondition(element) {
    const negate = element.Type === 'Not';
    return {
        negate,
        element: negate ? element.Test : element
    };
}

/**
 * Prepare the type.
 * @param {{Type: String=, Headers: *=}} element
 * @return {string} the type, or ''
 */
function prepareType(element) {
    const hasHeader = ({ Headers }, key, value = true) => Headers.includes(key) && value;
    const hasAnyHeader = (element, keys, value = true) => keys.some((key) => hasHeader(element, key)) && value;

    const MAP_TYPE = {
        Exists() {
            return hasHeader(element, 'X-Attached', 'attachments');
        },
        Header() {
            return hasHeader(element, 'Subject', 'subject');
        },
        Address() {
            return hasHeader(element, 'From', 'sender') || hasAnyHeader(element, ['To', 'Cc', 'Bcc'], 'recipient');
        }
    };
    return (MAP_TYPE[element.Type] || (() => false))() || '';
}

/**
 * Parses the different ifs.
 * @param {{Type: String, Test: *, ...}[]} ifConditions
 * @param {String[]} [commentComparators = []] - if known, the commentComparators.
 * @return {{Type: Object, Comparator: *, ...}[]} a list of conditions.
 */
function parseIfConditions(ifConditions, commentComparators = []) {
    const conditions = [];

    for (let index = 0; index < ifConditions.length; index++) {
        const { comparator: commentComparator, negate: commentNegate } = prepareComment(commentComparators[index]);

        const { element, negate } = prepareSingleCondition(ifConditions[index]);

        if (commentComparator && commentNegate !== negate) {
            throw new UnsupportedRepresentationError('Comment and computed negation incompatible');
        }

        const type = prepareType(element);

        const comparator = type === 'attachments' ? 'Contains' : element.Match.Type;
        const values = element.Keys || [];

        const params = buildSimpleParams(comparator, values, negate, commentComparator);

        conditions.push(buildSimpleCondition(type, comparator, params));
    }

    return conditions;
}

/**
 * Builds simple parameters.
 * @param {String} comparator
 * @param {String[]} values
 * @param {Boolean} negate
 * @param {String} [commentComparator=] - if given, will improve the type determination.
 * @return {{Comparator: {value: String, label: String}, Values: String[]}}
 */
function buildSimpleParams(comparator, values, negate, commentComparator) {
    if (commentComparator === 'starts' || commentComparator === 'ends') {
        if (comparator !== 'Matches') {
            throw new UnsupportedRepresentationError(
                `Comment and computed comparator incompatible: ${comparator} instead of matches`
            );
        }

        return {
            Comparator: buildSimpleComparator(commentComparator[0].toUpperCase() + commentComparator.slice(1), negate),
            Values: values.map((value) => {
                if (commentComparator === 'ends') {
                    return value.replace(/^\*+/g, '');
                }
                return value.replace(/\*+$/g, '');
            })
        };
    }

    if (commentComparator && comparator.toLowerCase() !== commentComparator) {
        // commentComparator is not required
        throw new UnsupportedRepresentationError(
            `Comment and computed comparator incompatible: ${comparator} instead of ${commentComparator}`
        );
    }

    return {
        Comparator: buildSimpleComparator(comparator, negate),
        Values: values
    };
}

/**
 * Builds a simple condition.
 * @param {String} type - the type (must be in LABEL_KEY)
 * @param {String} comparator - the comparator.
 * @param {*} params - any other params.
 * @return {{Type: Object, Comparator: *, ...}}
 */
function buildSimpleCondition(type, comparator, params) {
    return {
        Type: buildLabelValueObject(type),
        Comparator: buildLabelValueObject(comparator),
        ...params
    };
}

/**
 * Builds the simple comparator .
 * @param {String} comparator - the comparator
 * @param {Boolean} negate - if true, the comparator will be negated.
 * @return {{value: String, label: String}}
 */
function buildSimpleComparator(comparator, negate) {
    const inverted = invert(MATCH_KEYS);
    if (!inverted[comparator]) {
        throw new InvalidInputError('Invalid match keys');
    }

    return buildLabelValueObject((negate ? '!' : '') + inverted[comparator]);
}

/**
 * Parse the then nodes to extract the actions.
 * @param {{Type, ...}[]} thenNodes - all the then nodes.
 * @return {{FileInto: String[], Mark: {Read: Boolean, Starred: Boolean}, Vacation: String=}}
 */
function parseThenNodes(thenNodes) {
    const actions = {
        FileInto: [],
        Mark: {
            Read: false,
            Starred: false
        }
    };

    thenNodes.forEach((element) => {
        switch (element.Type) {
            case 'Keep':
                break;
            case 'Discard':
                actions.FileInto.push('trash');
                break;
            case 'FileInto':
                actions.FileInto.push(element.Name);
                break;

            case 'AddFlag':
                actions.Mark = {
                    Read: element.Flags.indexOf('\\Seen') > -1,
                    Starred: element.Flags.indexOf('\\Flagged') > -1
                };
                break;

            case 'Vacation':
            case 'Vacation\\Vacation':
                actions.Vacation = element.Message;
                break;
            default:
                throw new UnsupportedRepresentationError(`Unsupported filter representation: ${element.Type}`);
        }
    });

    return actions;
}

/**
 * Transforms a tree into a simple representation.
 * @param {Object[]} tree - a list of sieve nodes.
 * @return {{Operator: {label: String, value: String}, Conditions: Object[], Actions: {FileInto: Array, Mark: {Read: Boolean, Starred: Boolean}}}}
 */
export const fromTree = (tree) => {
    const validated = extractMainNode(tree);
    const validatedTree = JSON.parse(JSON.stringify(validated.tree)); // cloning it.
    const comment = parseComparatorComment(validated.comment);
    const operator = invert(OPERATOR_KEYS)[validatedTree.If.Type];

    if (comment && comment.type && operator !== comment.type) {
        throw new UnsupportedRepresentationError('Comment and computed type incompatible');
    }

    const conditions = parseIfConditions(validatedTree.If.Tests, comment && comment.comparators);
    return {
        Operator: {
            label: LABEL_KEYS[operator],
            value: operator
        },
        Conditions: [...conditions],
        Actions: parseThenNodes(validatedTree.Then)
    };
};
